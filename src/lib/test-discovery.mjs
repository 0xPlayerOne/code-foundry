// @ts-check

const TEST_FILE_PATTERN = /(?:\.(?:test|spec|unit|integration|smoke|e2e)\.(?:[cm]?[jt]sx?|py)|(?:^|\/)test_[^/]+\.py$|(?:^|\/)tests\/.*\.rs$)/i

/** @param {string} file */
export function isTestFile(file) {
  return TEST_FILE_PATTERN.test(file.replaceAll('\\', '/'))
}

/** @param {string} file */
export function testCategory(file) {
  const normalized = file.replaceAll('\\', '/').toLowerCase()
  const base = normalized.split('/').at(-1) ?? normalized

  if (/(^|\/)(e2e|end-to-end|acceptance)(\/|$)|(?:^|[._-])(e2e|acceptance)(?:[._-]|$)/.test(normalized)) {
    return 'e2e'
  }
  if (/(^|\/)(integration)(\/|$)|(?:^|[._-])integration(?:[._-]|$)/.test(normalized)) {
    return 'integration'
  }
  if (/(^|\/)(smoke|live)(\/|$)|(?:^|[._-])(smoke|live)(?:[._-]|$)/.test(normalized)) {
    return 'smoke'
  }

  if (normalized.endsWith('.rs') && /(^|\/)tests\//.test(normalized)) {
    return 'integration'
  }

  // Rust files under tests/ compile as integration-test binaries. An explicit
  // suffix still lets smoke and integration names win when they are present.
  if (base.endsWith('_smoke.rs')) return 'smoke'
  if (base.endsWith('_integration.rs')) return 'integration'
  return 'unit'
}

/** @param {string[]} files @param {'unit'|'integration'|'e2e'|'smoke'} task */
export function classifyTestFiles(files, task) {
  return files.filter((file) => isTestFile(file) && testCategory(file) === task)
}
