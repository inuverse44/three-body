// 三体問題シミュレーター（docs/plan.md）
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://inuverse44.github.io",
  base: "/three-body",
  trailingSlash: "always",
  markdown: { syntaxHighlight: false },
  vite: { build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|wasm)$/.test(file) ? false : undefined) } },
  // Q-03：読み込み元は自サイトだけ。WebAssembly を動かすために 'wasm-unsafe-eval' だけを追加で許可する
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-src 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ],
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
    },
  },
});
