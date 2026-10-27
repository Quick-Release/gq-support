// Native Node module hooks, using this repository's pinned TypeScript compiler.
// Needed for parameter properties in the shared declaration's source imports.
import { registerHooks } from "node:module";
import ts from "typescript";
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(".ts") || loaded.format !== "module-typescript") return loaded;
    return { ...loaded, format: "module", source: ts.transpileModule(String(loaded.source), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
      fileName: url,
    }).outputText };
  },
});
