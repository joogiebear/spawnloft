/** The pure parts of the MariaDB engine: reading the download API, the ini, the SQL. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { releasesFrom, stableMajorsFrom, windowsZipFrom, iniFor, attachSql, detachSql, quoteIdent, quoteStr } from '../src/mariadb.mjs'

test('releases come from the stable majors, each asked for its point releases, newest first', () => {
  // The shapes the API actually answers, level by level (probed 2026-09-06).
  const root = { major_releases: [
    { release_id: '13.0', release_name: '13.0', release_status: 'RC', release_support_type: 'Rolling' },
    { release_id: '11.8', release_name: '11.8', release_status: 'Stable', release_support_type: 'Long Term Support' },
    { release_id: '11.4', release_name: '11.4', release_status: 'Stable', release_support_type: 'Long Term Support' },
  ] }
  const majors = {
    '13.0': { releases: { '13.0.1': { release_id: '13.0.1', date_of_release: '2026-08-01' } } },
    '11.8': { releases: { '11.8.4': { release_id: '11.8.4', date_of_release: '2026-08-20' }, '11.8.3': { release_id: '11.8.3' } } },
    '11.4': { releases: { '11.4.13': { release_id: '11.4.13', date_of_release: '2026-08-22' }, '11.4.9': { release_id: '11.4.9' } } },
  }
  assert.deepEqual(stableMajorsFrom(root), ['11.8', '11.4'])
  assert.deepEqual(stableMajorsFrom(root, { includeUnstable: true }), ['13.0', '11.8', '11.4'])
  const list = releasesFrom(root, majors)
  assert.deepEqual(list.map((r) => r.version), ['11.8.4', '11.8.3', '11.4.13', '11.4.9'])
  assert.equal(list[0].status, 'Stable')
  assert.equal(list[0].support, 'Long Term Support')
  assert.equal(list[0].series, '11.8')
  assert.equal(list[0].date, '2026-08-20')
  assert.deepEqual(releasesFrom(root, majors, { includeUnstable: true }).map((r) => r.version), ['13.0.1', '11.8.4', '11.8.3', '11.4.13', '11.4.9'])
  // The old reading: `releases` on the root. The root has none, so this must be empty, not a crash.
  assert.deepEqual(releasesFrom({ releases: { '11.4.5': { release_id: '11.4.5', release_status: 'Stable' } } }), [])
  assert.deepEqual(releasesFrom({}), [])
  // A stable major the per-major request did not answer contributes nothing rather than failing.
  assert.deepEqual(releasesFrom(root, { '11.4': majors['11.4'] }).map((r) => r.version), ['11.4.13', '11.4.9'])
})

test('the Windows x64 zip is picked out of a release, with its checksum, not the debug symbols', () => {
  const files = [
    { file_name: 'mariadb-11.4.5-linux-systemd-x86_64.tar.gz', os: 'Linux', package_type: 'gzipped tar file', cpu: 'x86_64' },
    { file_name: 'mariadb-11.4.5-winx64-debugsymbols.zip', os: 'Windows', package_type: 'ZIP file', cpu: 'x86_64', checksum: { sha256sum: 'dbg' }, file_download_url: 'http://x/dbg.zip' },
    { file_name: 'mariadb-11.4.5-winx64.msi', os: 'Windows', package_type: 'MSI Package', cpu: 'x86_64' },
    { file_name: 'mariadb-11.4.5-winx64.zip', os: 'Windows', package_type: 'ZIP file', cpu: 'x86_64', size: 5, checksum: { sha256sum: 'abc' }, file_download_url: 'http://x/z.zip' },
  ]
  const want = { name: 'mariadb-11.4.5-winx64.zip', url: 'https://x/z.zip', sha256: 'abc', size: 5 }
  assert.deepEqual(windowsZipFrom({ files }), want)
  // A point release answers release_data keyed by version; a major answers releases the same way.
  assert.deepEqual(windowsZipFrom({ release_data: { '11.4.5': { release_id: '11.4.5', files } } }, '11.4.5'), want)
  assert.deepEqual(windowsZipFrom({ releases: { '11.4.5': { files } } }, '11.4.5'), want)
  assert.deepEqual(windowsZipFrom({ release_data: { '11.4.5': { files } } }), want)
  assert.equal(windowsZipFrom({ files: [files[0], files[1]] }), null)
  assert.equal(windowsZipFrom({}), null)
})

test('the ini pins the port to loopback and the data folder with forward slashes', () => {
  const ini = iniFor({ dir: 'C:\\Data\\services\\maria', port: 3307 })
  assert.match(ini, /^\[mysqld\]$/m)
  assert.match(ini, /^datadir=C:\/Data\/services\/maria\/data$/m)
  assert.match(ini, /^port=3307$/m)
  assert.match(ini, /^bind-address=127\.0\.0\.1$/m)
  assert.match(ini, /^skip-name-resolve$/m)
})

test('identifiers and strings are quoted so a name cannot break out of its statement', () => {
  assert.equal(quoteIdent('a`b'), '`a``b`')
  assert.equal(quoteStr("it's"), "'it''s'")
  assert.equal(quoteStr('a\\b'), "'a\\\\b'")
})

test('attach grants one database to the user on both loopback hosts, and repairs a repeat', () => {
  const sql = attachSql({ database: 'smp', user: 'smp', password: 'p4ss' })
  assert.match(sql, /^CREATE DATABASE IF NOT EXISTS `smp` CHARACTER SET utf8mb4/m)
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'smp'@'localhost' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'smp'@'127\.0\.0\.1' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^ALTER USER 'smp'@'localhost' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^GRANT ALL PRIVILEGES ON `smp`\.\* TO 'smp'@'localhost', 'smp'@'127\.0\.0\.1';$/m)
  assert.ok(!/GRANT ALL PRIVILEGES ON \*\.\*/.test(sql), 'never a global grant')
})

test('detach drops the user, and the database only when told to', () => {
  const keep = detachSql({ database: 'smp', user: 'smp' })
  assert.match(keep, /^DROP USER IF EXISTS 'smp'@'localhost', 'smp'@'127\.0\.0\.1';$/m)
  assert.ok(!/DROP DATABASE/.test(keep))
  assert.match(detachSql({ database: 'smp', user: 'smp', drop: true }), /^DROP DATABASE IF EXISTS `smp`;$/m)
})
