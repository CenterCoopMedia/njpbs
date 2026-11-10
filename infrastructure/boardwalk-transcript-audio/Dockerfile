FROM public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:f954f9b4184531bf898cde8410fb25da37071096aa8e086a5246b14ede291e07 AS build

ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SOURCE_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

RUN dnf install -y gcc make tar xz diffutils && dnf clean all
WORKDIR /build
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
      --output ffmpeg.tar.xz \
    && echo "${FFMPEG_SOURCE_SHA256}  ffmpeg.tar.xz" | sha256sum --check --strict \
    && mkdir source \
    && tar --extract --file ffmpeg.tar.xz --directory source --strip-components=1
WORKDIR /build/source
RUN ./configure \
      --prefix=/build/install \
      --disable-everything \
      --disable-autodetect \
      --disable-doc \
      --disable-debug \
      --disable-network \
      --disable-x86asm \
      --disable-shared \
      --enable-static \
      --enable-ffmpeg \
      --enable-ffprobe \
      --enable-protocol=file \
      --enable-protocol=pipe \
      --enable-demuxer=mov \
      --enable-muxer=mp4 \
      --enable-muxer=data \
      --enable-parser=aac \
      --enable-decoder=aac \
    && make -j4 \
    && make install
RUN ffmpeg_sha="$(sha256sum /build/install/bin/ffmpeg | cut -d' ' -f1)" \
    && ffprobe_sha="$(sha256sum /build/install/bin/ffprobe | cut -d' ' -f1)" \
    && artifact_sha="$(printf '%s\n%s\n' "$ffmpeg_sha" "$ffprobe_sha" | sha256sum | cut -d' ' -f1)" \
    && printf '{"schemaVersion":1,"ffmpegVersion":"%s","sourceSha256":"%s","ffmpegSha256":"%s","ffprobeSha256":"%s","artifactSha256":"%s"}\n' \
      "$FFMPEG_VERSION" "$FFMPEG_SOURCE_SHA256" "$ffmpeg_sha" "$ffprobe_sha" "$artifact_sha" \
      > /build/install/bin/ffmpeg-manifest.json

FROM public.ecr.aws/lambda/python:3.13@sha256:872a5717861501bd24e317134db766b7522ef95da6e8d0f3bf4726422fcd6e6b

COPY --from=build /build/install/bin/ffmpeg /opt/bin/ffmpeg
COPY --from=build /build/install/bin/ffprobe /opt/bin/ffprobe
COPY --from=build /build/install/bin/ffmpeg-manifest.json /opt/bin/ffmpeg-manifest.json
COPY worker.py ${LAMBDA_TASK_ROOT}/worker.py

CMD ["worker.handler"]
