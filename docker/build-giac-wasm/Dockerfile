# Giac → WebAssembly build container
#
# Usage:
#   docker build -t axiom-giac-wasm-builder .
#   docker run --rm -v /path/to/src/server/giac:/output axiom-giac-wasm-builder
#
# Or from the project root:
#   npm run build:giac:wasm
#
# Output: /output/giac.wasm.js (~6.5MB, WASM binary embedded as base64)

# GeoGebra/giac Gradle build does not recognize linux_aarch64.
# WASM output is platform-independent, so we force x86_64.
FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy

# Build tools for Emscripten/Gradle
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    curl \
    wget \
    make \
    cmake \
    xz-utils \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# GIAC_REF: branch/tag/commit to clone from the geogebra/giac repo
ARG GIAC_REF=master

RUN git clone --depth=1 --branch=${GIAC_REF} \
    https://github.com/geogebra/giac.git

WORKDIR /build/giac

RUN chmod +x gradlew

# /proc/self/mountinfo does not exist inside Docker containers,
# which causes Gradle VFS file watching to crash. Disable it.
ENV GRADLE_OPTS="-Dorg.gradle.vfs.watch=false"

# Each task runs in a separate RUN layer — failed steps are immediately visible
# and successful layers are cached (speeds up rebuilds).
# "══ TASK: ..." markers are used by the build script to split log files.

RUN echo "══ TASK: downloadEmsdk ══" && \
    ./gradlew downloadEmsdk \
    --no-daemon --no-watch-fs --stacktrace

RUN echo "══ TASK: installEmsdk ══" && \
    ./gradlew installEmsdk \
    --no-daemon --no-watch-fs --stacktrace

RUN echo "══ TASK: activateEmsdk ══" && \
    ./gradlew activateEmsdk \
    --no-daemon --no-watch-fs --stacktrace

RUN echo "══ TASK: createGiacWasmJs ══" && \
    ./gradlew createGiacWasmJs \
    --no-daemon --no-watch-fs --stacktrace --info

# Copy output to the mounted /output directory
ENTRYPOINT ["sh", "-c", \
    "cp build/binaries/giacggb.wasm/giac.wasm.js /output/giac.wasm.js \
     && echo '✅ Build complete: giac.wasm.js copied to /output/'"]
