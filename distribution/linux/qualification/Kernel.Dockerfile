FROM docker.io/rockylinux/rockylinux@sha256:f5529992e67440c1a4ae7788244d4381c6909159a88eacd95b7523ae47ced82e
RUN dnf install -y gcc make bison flex elfutils-libelf-devel bc openssl-devel \
    perl-core cpio gzip tar xz diffutils findutils python3 && dnf clean all
WORKDIR /build
