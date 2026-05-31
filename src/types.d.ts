declare module '*.wasm' {
  const path: string;
  export default path;
}

declare module '*.data' {
  const path: string;
  export default path;
}

declare module '*.tar.gz' {
  const path: string;
  export default path;
}

// transformers.js uses conditional exports that resolve to its `node` build
// in Bun, which requires the `onnxruntime-node` native binding (cannot be
// embedded in a `bun build --compile` artifact). We dynamic-import the web
// build via its dist path to force the WASM backend.
declare module '*/transformers.web.js' {
  export * from '@huggingface/transformers';
}
