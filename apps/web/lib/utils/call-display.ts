/** Call list/detail shapes before and after the `title` field lands in the OpenAPI spec. */
export type CallDisplayFields = {
  filename: string;
  title?: string | null;
};

export function getCallDisplayTitle(call: CallDisplayFields): string {
  return call.title ?? call.filename;
}
