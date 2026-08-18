#!/bin/bash
# Build the NanoClaw agent container image.
#
# Builds the image named by $CONTAINER_IMAGE (the same env var the host runtime
# reads in src/config.ts), so per-bot deployments stay in sync.
#
# Override priority (highest first):
#   1. positional argument:    ./build.sh my-image:tag
#   2. CONTAINER_IMAGE env var
#
# Context is sent directly to the builder; on Apple Container ≥0.12.0 the
# .dockerignore reliably excludes agent-runner/{node_modules,dist} so the
# host-side build artifacts never leak into the image. The 0.11.0 trap-aside
# workaround for apple/container#1375 was removed once 0.12.x burned in.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="${1:-${CONTAINER_IMAGE:-}}"
if [ -z "$IMAGE" ]; then
  echo "Error: image name is required." >&2
  echo "Pass nanoclaw-agent-unic:latest or nanoclaw-agent-chef:latest as the first argument:" >&2
  echo "  ./container/build.sh nanoclaw-agent-unic:latest" >&2
  echo "Or set CONTAINER_IMAGE:" >&2
  echo "  CONTAINER_IMAGE=nanoclaw-agent-chef:latest ./container/build.sh" >&2
  exit 1
fi

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

cleanup_apple_container_build_cache() {
  # Other runtimes have different prune semantics. Keep this cleanup scoped to
  # Apple's `container` CLI, where image snapshots and the builder VM otherwise
  # grow after every rebuild.
  [ "${CONTAINER_RUNTIME##*/}" = "container" ] || return 0
  [ "${NANOCLAW_BUILD_CLEANUP:-1}" != "0" ] || return 0

  echo "Pruning dangling Apple Container images..."
  if ! "${CONTAINER_RUNTIME}" image prune; then
    echo "Warning: dangling image prune failed; the completed image is still usable." >&2
  fi

  # Retain the warm BuildKit cache while disk space is healthy. Under pressure,
  # discard the builder VM after a successful build; Apple Container recreates
  # it on the next build. Never stop it while another build is in progress.
  local cleanup_water_gb="${NANOCLAW_BUILDER_CLEANUP_WATER_GB:-40}"
  local free_kb
  free_kb=$(df -k / | awk 'NR == 2 { print $4 }')
  if [ "${free_kb:-0}" -ge "$((cleanup_water_gb * 1024 * 1024))" ]; then
    echo "Keeping warm builder cache (${free_kb} KiB free; threshold ${cleanup_water_gb} GiB)."
    return 0
  fi

  if pgrep -f '(^|/)container([[:space:]]+--debug)?[[:space:]]+build([[:space:]]|$)' >/dev/null 2>&1; then
    echo "Warning: another Apple Container build is active; keeping builder cache." >&2
    return 0
  fi

  echo "Disk space is below ${cleanup_water_gb} GiB; removing the BuildKit cache..."
  "${CONTAINER_RUNTIME}" builder stop >/dev/null 2>&1 || true
  if "${CONTAINER_RUNTIME}" builder delete >/dev/null 2>&1; then
    echo "BuildKit cache removed. It will be recreated on the next build."
  else
    echo "Warning: BuildKit cache removal failed; the completed image is still usable." >&2
  fi
}

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE}"

${CONTAINER_RUNTIME} build -t "${IMAGE}" .

cleanup_apple_container_build_cache

echo ""
echo "Build complete!"
echo "Image: ${IMAGE}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE}"
