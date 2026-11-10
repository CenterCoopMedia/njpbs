// Match the server's eight-character alphabet, with an optional middle hyphen.
// Query input is deliberately stricter than manual entry: ignore garbage and duplicates.
export function parsePremiereConnectionCode(search: string): string {
  const values = new URLSearchParams(search).getAll("code");
  if (values.length !== 1 || values[0].trim() !== values[0] ||
      !/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i.test(values[0])) return "";
  const code = values[0].toUpperCase().replace("-", "");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
