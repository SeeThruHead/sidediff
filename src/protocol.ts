import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

export const Side = Schema.Literals(['additions', 'deletions']);
export type Side = typeof Side.Type;

const Line = Schema.Int.check(Schema.isGreaterThan(0));

export const NoteKind = Schema.Literals(['annotation', 'comment']);
export type NoteKind = typeof NoteKind.Type;

export const isComment = (note: { readonly kind?: NoteKind }) => note.kind === 'comment';

export const Reply = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.NonEmptyString,
  createdAt: Schema.String,
});
export type Reply = typeof Reply.Type;

export const Note = Schema.Struct({
  id: Schema.String,
  filePath: Schema.String,
  side: Side,
  line: Line,
  summary: Schema.String,
  rationale: Schema.optionalKey(Schema.String),
  author: Schema.String,
  createdAt: Schema.String,
  replies: Schema.optionalKey(Schema.Array(Reply)),
  resolved: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(NoteKind),
});
export type Note = typeof Note.Type;

export const NoteInput = Schema.Struct({
  filePath: Schema.NonEmptyString,
  newLine: Schema.optionalKey(Line),
  oldLine: Schema.optionalKey(Line),
  summary: Schema.NonEmptyString,
  rationale: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(NoteKind),
});
export type NoteInput = typeof NoteInput.Type;

export const NoteBatch = Schema.Union([
  Schema.Array(NoteInput),
  Schema.Struct({ comments: Schema.Array(NoteInput) }),
]);

export const Snapshot = Schema.Struct({
  repo: Schema.String,
  branch: Schema.String,
  range: Schema.Array(Schema.String),
  patch: Schema.String,
  notes: Schema.Array(Note),
  version: Schema.String,
  diffVersion: Schema.String,
  watching: Schema.Boolean,
  updatedAt: Schema.String,
});
export type Snapshot = typeof Snapshot.Type;

const targetFields = {
  file: Schema.String,
  start: Schema.optionalKey(Line),
  end: Schema.optionalKey(Line),
  side: Side,
  text: Schema.optionalKey(Schema.String),
};

export const Target = Schema.Struct(targetFields);
export type Target = typeof Target.Type;

const explanationFields = {
  ...targetFields,
  title: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
};

export const Explanation = Schema.Struct(explanationFields);
export type Explanation = typeof Explanation.Type;

export const Step = Schema.Union([
  Schema.Struct({ type: Schema.Literal('show'), ...targetFields }),
  Schema.Struct({ type: Schema.Literal('highlight'), ...targetFields }),
  Schema.Struct({ type: Schema.Literal('explain'), speak: Schema.optionalKey(Schema.Boolean), ...explanationFields }),
  Schema.Struct({ type: Schema.Literal('say'), text: Schema.String, speak: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal('clear') }),
]);
export type Step = typeof Step.Type;

export const Steps = Schema.Array(Step);

export const Command = Schema.Union([
  Step,
  Schema.Struct({ type: Schema.Literal('tour'), steps: Steps }),
  Schema.Struct({ type: Schema.Literal('next') }),
  Schema.Struct({ type: Schema.Literal('back') }),
  Schema.Struct({ type: Schema.Literal('goto'), index: Schema.Int }),
]);
export type Command = typeof Command.Type;

export const View = Schema.Struct({
  file: Schema.NullOr(Schema.String),
  activeNote: Schema.NullOr(Schema.String),
  tourStep: Schema.NullOr(Schema.Int),
  explaining: Schema.NullOr(Schema.String),
});
export type View = typeof View.Type;

export const Utterance = Schema.Struct({
  id: Schema.Int,
  text: Schema.String,
  at: Schema.String,
  handled: Schema.Boolean,
});
export type Utterance = typeof Utterance.Type;

export const ThreadEvent = Schema.Struct({
  seq: Schema.Int,
  kind: Schema.Literals(['thread', 'reply', 'resolved', 'reopened', 'converted']),
  noteId: Schema.String,
  filePath: Schema.String,
  side: Side,
  line: Line,
  author: Schema.String,
  body: Schema.String,
  at: Schema.String,
});
export type ThreadEvent = typeof ThreadEvent.Type;

export class NoteMissing extends Schema.TaggedError<NoteMissing>()('NoteMissing', { id: Schema.String }) {
  override get message() {
    return `no note ${this.id}`;
  }
}

export class NoteUnsaved extends Schema.TaggedError<NoteUnsaved>()('NoteUnsaved', { reason: Schema.String }) {
  override get message() {
    return this.reason;
  }
}

export class FileMissing extends Schema.TaggedError<FileMissing>()('FileMissing', {
  side: Schema.Literals(['old', 'new']),
  path: Schema.String,
}) {}

const Column = Schema.Int.check(Schema.isGreaterThan(0));

const codePositionFields = { path: Schema.NonEmptyString, line: Line, offset: Column };

export const CodePosition = Schema.Struct(codePositionFields);
export type CodePosition = typeof CodePosition.Type;

export const HoverInfo = Schema.Struct({ markdown: Schema.String });
export type HoverInfo = typeof HoverInfo.Type;

export const Severity = Schema.Literals(['error', 'warning', 'info', 'hint']);
export type Severity = typeof Severity.Type;

export const Diagnostic = Schema.Struct({
  source: Schema.String,
  severity: Severity,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  line: Line,
  column: Column,
  endLine: Line,
  endColumn: Column,
});
export type Diagnostic = typeof Diagnostic.Type;

export const CodeLocation = Schema.Struct({
  path: Schema.String,
  inRepo: Schema.Boolean,
  line: Line,
  offset: Column,
  endLine: Line,
  endOffset: Column,
  preview: Schema.String,
  isDefinition: Schema.Boolean,
});
export type CodeLocation = typeof CodeLocation.Type;

export class LanguageUnavailable extends Schema.TaggedError<LanguageUnavailable>()('LanguageUnavailable', {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.path}: ${this.reason}`;
  }
}

export const SidediffRpcs = RpcGroup.make(
  Rpc.make('Hover', { payload: codePositionFields, success: Schema.NullOr(HoverInfo), error: LanguageUnavailable }),
  Rpc.make('Definition', {
    payload: codePositionFields,
    success: Schema.Array(CodeLocation),
    error: LanguageUnavailable,
  }),
  Rpc.make('References', {
    payload: codePositionFields,
    success: Schema.Array(CodeLocation),
    error: LanguageUnavailable,
  }),
  Rpc.make('Source', { payload: { path: Schema.NonEmptyString }, success: Schema.String, error: FileMissing }),
  Rpc.make('Diagnostics', {
    payload: { path: Schema.NonEmptyString },
    success: Schema.Array(Diagnostic),
    stream: true,
  }),
  Rpc.make('Snapshots', { success: Snapshot, stream: true }),
  Rpc.make('File', {
    payload: { side: Schema.Literals(['old', 'new']), path: Schema.NonEmptyString },
    success: Schema.String,
    error: FileMissing,
  }),
  Rpc.make('Send', { payload: { command: Command }, success: Schema.Struct({ delivered: Schema.Int }) }),
  Rpc.make('Commands', { success: Command, stream: true }),
  Rpc.make('ReportView', { payload: { view: View } }),
  Rpc.make('View', { success: Schema.NullOr(View) }),
  Rpc.make('Utter', { payload: { text: Schema.NonEmptyString, handled: Schema.Boolean }, success: Utterance }),
  Rpc.make('Listen', {
    payload: { after: Schema.optionalKey(Schema.Int) },
    success: Schema.Array(Utterance),
    stream: true,
  }),
  Rpc.make('StartThread', {
    payload: { filePath: Schema.NonEmptyString, side: Side, line: Line, body: Schema.NonEmptyString },
    success: Note,
    error: NoteUnsaved,
  }),
  Rpc.make('Reply', {
    payload: { noteId: Schema.NonEmptyString, body: Schema.NonEmptyString, author: Schema.optionalKey(Schema.String) },
    success: Note,
    error: Schema.Union([NoteMissing, NoteUnsaved]),
  }),
  Rpc.make('ToComment', {
    payload: { noteId: Schema.NonEmptyString },
    success: Note,
    error: Schema.Union([NoteMissing, NoteUnsaved]),
  }),
  Rpc.make('Resolve', {
    payload: { noteId: Schema.NonEmptyString, resolved: Schema.Boolean, author: Schema.optionalKey(Schema.String) },
    success: Note,
    error: Schema.Union([NoteMissing, NoteUnsaved]),
  }),
  Rpc.make('Refresh', {}),
  Rpc.make('ListNotes', { success: Schema.Array(Note) }),
  Rpc.make('AddNotes', { payload: { notes: Schema.Array(NoteInput) }, success: Schema.Array(Note), error: NoteUnsaved }),
  Rpc.make('RemoveNote', { payload: { id: Schema.NonEmptyString }, error: NoteUnsaved }),
  Rpc.make('ClearNotes', {
    payload: { filePath: Schema.optionalKey(Schema.String) },
    success: Schema.Int,
    error: NoteUnsaved,
  }),
  Rpc.make('Threads', {
    payload: { after: Schema.optionalKey(Schema.Int) },
    success: Schema.Array(ThreadEvent),
    stream: true,
  }),
);
