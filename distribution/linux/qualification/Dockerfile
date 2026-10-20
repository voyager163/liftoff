FROM docker.io/library/ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install --no-install-recommends -y \
    qemu-system-arm qemu-system-x86 cpio gzip
WORKDIR /work
