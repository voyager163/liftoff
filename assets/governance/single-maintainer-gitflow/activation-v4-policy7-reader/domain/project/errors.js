export class FileSystemError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'FileSystemError';
  }
}
