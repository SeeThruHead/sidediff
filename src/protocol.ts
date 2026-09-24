import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';

export const Side = Schema.Literals(['additions', 'deletions']);
export type Side = typeof Side.Type;

const Line = Schema.Int.check(Schema.isGreaterThan(0));

export const Note = Schema.Struct({
  id: Schema.String,
  filePath: Schema.String,
  side: Side,
  line: Line,
  summary: Schema.String,
  rationale: Schema.optionalKey(Schema.String),
  author: Schema.String,
  createdAt: Schema.String,
});
export type Note = typeof Note.Type;

export const NoteInput = Schema.Struct({
  filePath: Schema.NonEmptyString,
  newLine: Schema.optionalKey(Line),
  oldLine: Schema.optionalKey(Line),
  summary: Schema.NonEmptyString,
  rationale: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
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

export class FileMissing extends Schema.TaggedError<FileMissing>()('FileMissing', {
  side: Schema.Literals(['old', 'new']),
  path: Schema.String,
}) {}

export const SidediffRpcs = RpcGroup.make(
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
);
