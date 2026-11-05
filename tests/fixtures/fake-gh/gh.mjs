// Stands in for the GitHub CLI in tests: `node gh.mjs api --method M ... ROUTE [--input -]`.
// It answers a few routes, and echoes what it was asked for.
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const route = args.find((arg) => arg.startsWith("/"));
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (route === "/missing") {
    process.stderr.write("gh: Not Found (HTTP 404)\n");
    process.exitCode = 1;
  } else if (route === "/refused") {
    process.stderr.write("gh: Repository rule violations found (HTTP 422)\n");
    process.exitCode = 1;
  } else if (route === "/broken") {
    process.stderr.write("error connecting to api.github.com\n");
    process.exitCode = 1;
  } else if (route === "/empty") {
    // A 204 answer: nothing printed.
  } else {
    process.stdout.write(JSON.stringify({ method, route, args, body: input ? JSON.parse(input) : null }));
  }
});
