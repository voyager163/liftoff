/**
 * Fills `{{liftoff.key}}` placeholders. Nothing else in a template is touched,
 * so GitHub Actions expressions such as `${{ github.ref }}` pass through.
 * An unknown key is an error, never left in the output.
 */
export function renderTemplate(
  text: string,
  values: Readonly<Record<string, string>>,
  source: string,
): string {
  return text.replace(/\{\{liftoff\.([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${source}: unknown placeholder {{liftoff.${key}}}`);
    return value;
  });
}
