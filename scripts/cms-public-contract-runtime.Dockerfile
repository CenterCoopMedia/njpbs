FROM eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a AS java
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ADD --chmod=0444 --checksum=sha256:9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar /opt/cms-runtime/cloud-firestore-emulator-v1.22.0.jar
RUN chmod 0755 /opt/cms-runtime
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
ENV FIREBASE_EMULATORS_PATH=/opt/cms-runtime
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["node", "/inputs/trusted/scripts/check-cms-public-contract.mjs", "inside"]
