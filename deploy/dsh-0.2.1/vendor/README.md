# dsh-mermaid-web

Pinned 0.1.0 distribution copied unchanged from the existing enterprise 0.1.5 image.
Upstream: https://github.com/terrywangcode/dsh-mermaid-web (MIT; LICENSE included in archive).
SHA256: `044040325e27541bdf59a1859ac3127d0f0c9733d1372317722cc31da94b4e87`.

The browser entry bundles Mermaid 11.16.0. No CDN, npm install or consumer build
is needed. Full and overlay image builds extract this distribution and apply
`patch-mermaid.mjs` for rc3 code-language/streaming markers and Chinese controls.
The previous enterprise Mermaid observer is removed to prevent double rendering.
