/**
 * @param {string} stderr
 * @param {string} name
 * @param {number} port
 */
export function isContainerPortPending(stderr, name, port) {
  return /no such (object|container)/i.test(stderr) ||
    stderr.trim() === `Error: No public port '${port}/tcp' published for ${name}`;
}
