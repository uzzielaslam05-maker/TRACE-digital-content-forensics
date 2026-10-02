# syntax=docker/dockerfile:1

# Debian-based (not alpine): sharp's and onnxruntime-node's prebuilt native
# binaries are built against glibc, not musl -- alpine would silently fail
# to load them at runtime.
FROM node:22-slim

WORKDIR /app

# pnpm, pinned to the version this project was developed and tested with.
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Copy the whole monorepo. Simpler than a selective copy for Docker layer
# caching, and fine here: this project is deployed rarely, not on every
# commit, so full-reinstall build time isn't a real cost.
COPY . .

# The two .onnx model files are tracked with Git LFS, but LFS support is
# inconsistent across hosting providers -- notably, Railway's GitHub
# integration does not resolve LFS pointers at all, which silently leaves
# tiny 130-byte placeholder text files in place of the real binaries. To
# make this Dockerfile work the same way everywhere, fetch the real files
# fresh from GitHub Releases (a plain file download, unrelated to Git LFS)
# and overwrite whatever git checked out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fL -o artifacts/api-server/models/ai_image_detector.onnx \
       https://github.com/uzzielaslam05-maker/TRACE-digital-content-forensics/releases/download/models-v1/ai_image_detector.onnx \
  && curl -fL -o artifacts/api-server/models/text-detector/model.onnx \
       https://github.com/uzzielaslam05-maker/TRACE-digital-content-forensics/releases/download/models-v1/model.onnx

# pnpm-workspace.yaml's `allowBuilds` map pre-approves every native
# postinstall script this project needs (esbuild, sharp, protobufjs, etc.)
# so this installs fully non-interactively -- no `pnpm approve-builds`
# prompt, which wouldn't work in a Docker build anyway.
#
# onnxruntime-node's own postinstall is explicitly set to `false` in that
# same map: it only fetches optional extras from api.nuget.org, and the npm
# package already ships a working prebuilt binary for linux-x64 without it,
# so skipping it avoids depending on that endpoint being reachable at all.
RUN pnpm install --frozen-lockfile

# The frontend build validates these at build time (see vite.config.ts) but
# doesn't need them to be meaningful -- PORT here is unrelated to the actual
# port the container serves on later; BASE_PATH=/ means assets are served
# from the site root, which matches serving everything from one container.
ENV PORT=3000
ENV BASE_PATH=/

# Builds every workspace package (typecheck, then each package's own build:
# lib/db, lib/api-zod, lib/api-client-react, artifacts/trace,
# artifacts/api-server) via the root package.json's `build` script.
RUN pnpm run build

# Hugging Face Spaces' Docker SDK expects the container to listen on 7860
# by default.
ENV PORT=7860
ENV NODE_ENV=production
EXPOSE 7860

# DATABASE_URL is intentionally not set here -- it's provided as a Space
# secret at runtime (Settings -> Variables and secrets), never baked into
# the image.
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]