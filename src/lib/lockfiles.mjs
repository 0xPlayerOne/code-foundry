// @ts-check

/** @type {Readonly<Record<string, string>>} */
const managers = Object.freeze({
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
})

/** @param {string | undefined} file @returns {string | undefined} */
export function packageManagerForLockfile(file) {
  return file && Object.hasOwn(managers, file) ? managers[file] : undefined
}
