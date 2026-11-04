# dsh-mermaid-web

Pinned 0.1.0 distribution copied unchanged from the existing enterprise 0.1.5 image.
Upstream: https://github.com/terrywangcode/dsh-mermaid-web (MIT; LICENSE included in archive).
SHA256: `044040325e27541bdf59a1859ac3127d0f0c9733d1372317722cc31da94b4e87`.

The browser entry bundles Mermaid 11.16.0. No CDN, npm install or consumer build
is needed. Full and overlay image builds extract this distribution and apply
`patch-mermaid.mjs` for rc3 code-language/streaming markers and Chinese controls.
The previous enterprise Mermaid observer is removed to prevent double rendering.

# dsh-visual-workflow

Runtime files from tag v0.10.3, commit `0f388c178bc917204e24cda62086a0610c294651`.
Upstream: https://github.com/GZX2211/dsh-Visual-Workflow (MIT; LICENSE included).
Each included file was checked against its Git blob ID. The archive omits
source maps and optional database/embedding assets.
SHA256: `e2fa5c195606d2b601b9eecd39ce584a57d9718a4adf281a6122c7f35897acc0`.
