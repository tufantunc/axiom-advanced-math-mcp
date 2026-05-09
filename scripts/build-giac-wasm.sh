#!/usr/bin/env bash
#
# Giac WASM Build Script
#
# Builds WebAssembly from the geogebra/giac repository inside a Docker container
# and saves the output to src/server/giac/giac.wasm.js.
#
# Usage:
#   npm run build:giac:wasm
#   GIAC_REF=v1.9.x npm run build:giac:wasm
#
# To update giac:
#   GIAC_REF=master npm run build:giac:wasm
#   git add src/server/giac/giac.wasm.js
#   git commit -m "chore: update giac WASM build"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/src/server/giac"
IMAGE_NAME="axiom-giac-wasm-builder"
DOCKERFILE="$PROJECT_ROOT/docker/build-giac-wasm/Dockerfile"
LOG_DIR="$PROJECT_ROOT/logs/giac-build"

GIAC_REF="${GIAC_REF:-master}"
BUILD_START=$SECONDS

# ── Prepare log directory ──────────────────────────────────
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
FULL_LOG="$LOG_DIR/00-full-build.log"

# ── Elapsed timer ──────────────────────────────────────────
TIMER_PID=""

start_timer() {
  local label="$1"
  (
    while true; do
      elapsed=$(( SECONDS - BUILD_START ))
      mins=$(( elapsed / 60 ))
      secs=$(( elapsed % 60 ))
      printf "\r\033[K⏱  %s — %02d:%02d elapsed" "$label" "$mins" "$secs" >&2
      sleep 5
    done
  ) &
  TIMER_PID=$!
}

stop_timer() {
  if [[ -n "$TIMER_PID" ]]; then
    kill "$TIMER_PID" 2>/dev/null || true
    wait "$TIMER_PID" 2>/dev/null || true
    TIMER_PID=""
    printf "\r\033[K" >&2
  fi
}

trap stop_timer EXIT

# ── Split logs by task ─────────────────────────────────────
split_logs() {
  local full_log="$1"
  local log_dir="$2"
  local task_num=0
  local current_file=""

  while IFS= read -r line; do
    # Strip Docker buildkit line prefix (#N <timestamp> ...)
    local clean="${line#*\] }"

    # Check for task marker
    if [[ "$line" == *"══ TASK: "* ]]; then
      task_num=$((task_num + 1))
      # Extract task name
      local task_name
      task_name=$(echo "$line" | sed -n 's/.*══ TASK: \([^ ]*\) ══.*/\1/p')
      if [[ -n "$task_name" ]]; then
        current_file="$log_dir/$(printf '%02d' $task_num)-${task_name}.log"
        echo "── $task_name ──" > "$current_file"
      fi
    fi

    # Write to active task file
    if [[ -n "$current_file" ]]; then
      echo "$line" >> "$current_file"
    fi
  done < "$full_log"
}

# ── Banner ─────────────────────────────────────────────────
echo "═══════════════════════════════════════════════"
echo "  Giac → WebAssembly Build"
echo "  Ref: $GIAC_REF"
echo "  Output: $OUTPUT_DIR/giac.wasm.js"
echo "  Logs:   $LOG_DIR/"
echo "═══════════════════════════════════════════════"
echo ""

# Check Docker daemon is running
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker daemon is not running. Please start Docker Desktop."
  exit 1
fi

# ── Step 1: Docker image build ─────────────────────────────
echo "🐳 [1/2] Building Docker image..."
echo "    Log: $FULL_LOG"
echo ""
start_timer "Docker image build"

BUILD_EXIT=0
docker build \
  --platform linux/amd64 \
  --build-arg GIAC_REF="$GIAC_REF" \
  --tag "$IMAGE_NAME" \
  --file "$DOCKERFILE" \
  --progress=plain \
  "$PROJECT_ROOT/docker/build-giac-wasm" 2>&1 | tee "$FULL_LOG" || BUILD_EXIT=$?

stop_timer

# ── Split logs by task ─────────────────────────────────────
echo ""
echo "📋 Splitting logs..."
split_logs "$FULL_LOG" "$LOG_DIR"

step1_elapsed=$(( SECONDS - BUILD_START ))

# ── Handle build failure ───────────────────────────────────
if [[ $BUILD_EXIT -ne 0 ]]; then
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "❌ Docker image build FAILED (exit $BUILD_EXIT)"
  printf "   Duration: %02d:%02d\n" $(( step1_elapsed / 60 )) $(( step1_elapsed % 60 ))
  echo "═══════════════════════════════════════════════"
  echo ""
  echo "📁 Log files:"
  ls -lh "$LOG_DIR"/*.log 2>/dev/null | while read -r line; do
    echo "   $line"
  done
  echo ""

  # Show last 40 lines of the failing task log
  LAST_TASK_LOG=$(ls -t "$LOG_DIR"/0[1-9]*.log 2>/dev/null | head -1)
  if [[ -n "$LAST_TASK_LOG" ]]; then
    echo "📄 Last 40 lines of failing task log ($(basename "$LAST_TASK_LOG")):"
    echo "───────────────────────────────────────────"
    tail -40 "$LAST_TASK_LOG"
    echo "───────────────────────────────────────────"
    echo ""
    echo "Full log: $LAST_TASK_LOG"
  fi

  echo ""
  echo "💡 Full log:    $FULL_LOG"
  echo "💡 Search errors: grep -i 'error\\|fatal' $FULL_LOG"
  exit $BUILD_EXIT
fi

printf "✓  Docker image build — %02d:%02d\n\n" $(( step1_elapsed / 60 )) $(( step1_elapsed % 60 ))

# ── Step 2: Copy WASM output ───────────────────────────────
echo "⚙️  [2/2] Copying WASM output..."
docker run --rm \
  --platform linux/amd64 \
  --volume "$OUTPUT_DIR:/output" \
  "$IMAGE_NAME"

# ── Result ─────────────────────────────────────────────────
total_elapsed=$(( SECONDS - BUILD_START ))
echo ""
echo "═══════════════════════════════════════════════"
printf "✅ Build complete! (total %02d:%02d)\n" $(( total_elapsed / 60 )) $(( total_elapsed % 60 ))
echo ""
echo "File: $OUTPUT_DIR/giac.wasm.js"
echo "Size: $(du -sh "$OUTPUT_DIR/giac.wasm.js" 2>/dev/null | cut -f1 || echo 'unknown')"
echo ""
echo "📁 Log files: $LOG_DIR/"
ls -lh "$LOG_DIR"/*.log 2>/dev/null | while read -r line; do
  echo "   $line"
done
echo ""
echo "To use:"
echo "  npm start"
echo ""
echo "To test:"
echo "  npm test"
echo "═══════════════════════════════════════════════"
