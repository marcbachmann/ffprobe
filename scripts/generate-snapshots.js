#!/usr/bin/env node
'use strict'

/**
 * Generates test_data/*.json snapshot files from our ffprobe library.
 * Also compares against the official ffprobe CLI to highlight differences.
 *
 * Usage: node scripts/generate-snapshots.js [--compare]
 */

const {execFileSync} = require('child_process')
const {writeFileSync, readdirSync} = require('fs')
const {join, basename, extname} = require('path')
const ffprobe = require('..')

const FFPROBE_CLI =
  process.env.FFPROBE_BIN ||
  (() => {
    for (const p of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']) {
      try {
        require('fs').accessSync(p)
        return p
      } catch {}
    }
    // Try globbing homebrew cellar
    try {
      const {execFileSync} = require('child_process')
      return execFileSync('sh', ['-c', 'ls /opt/homebrew/Cellar/ffmpeg/*/bin/ffprobe | tail -1'], {
        encoding: 'utf8'
      }).trim()
    } catch {}
    return null
  })()

const MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mp3',
  '.m4a',
  '.flac',
  '.wav',
  '.opus'
])

const testDataDir = join(__dirname, '../test/test_data')
const compare = process.argv.includes('--compare')

async function main() {
  const files = readdirSync(testDataDir)
    .filter((f) => MEDIA_EXTENSIONS.has(extname(f)))
    .sort()

  console.log(`Generating snapshots for ${files.length} files...\n`)

  for (const file of files) {
    const filePath = join(testDataDir, file)
    const snapshotPath = join(testDataDir, file + '.json')

    let result
    try {
      result = await ffprobe(filePath)
    } catch (err) {
      console.error(`ERROR probing ${file}: ${err.message}`)
      continue
    }

    const json = JSON.stringify(result, null, 2) + '\n'
    writeFileSync(snapshotPath, json, 'utf8')
    console.log(`  wrote ${basename(snapshotPath)}`)

    if (compare && FFPROBE_CLI) {
      try {
        const cliOutput = execFileSync(
          FFPROBE_CLI,
          [
            '-v',
            'quiet',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            '-show_chapters',
            filePath
          ],
          {encoding: 'utf8'}
        )
        const cliResult = JSON.parse(cliOutput)

        // Remove filename from CLI output since we intentionally omit it
        delete cliResult.format.filename

        const diffs = diffObjects(result, cliResult, file)
        if (diffs.length === 0) {
          console.log(`    ✓ matches CLI output`)
        } else {
          console.log(`    differences from CLI:`)
          for (const d of diffs) console.log(`      ${d}`)
        }
      } catch (err) {
        console.log(`    (CLI comparison skipped: ${err.message.split('\n')[0]})`)
      }
    }
  }

  console.log('\nDone.')
}

function diffObjects(ours, theirs, label, path = '') {
  const diffs = []

  if (typeof ours !== typeof theirs) {
    diffs.push(`${path}: type mismatch (ours=${typeof ours}, theirs=${typeof theirs})`)
    return diffs
  }

  if (ours === null || theirs === null || typeof ours !== 'object') {
    if (String(ours) !== String(theirs)) {
      diffs.push(`${path}: ours=${JSON.stringify(ours)} CLI=${JSON.stringify(theirs)}`)
    }
    return diffs
  }

  if (Array.isArray(ours) && Array.isArray(theirs)) {
    if (ours.length !== theirs.length) {
      diffs.push(`${path}[]: length mismatch (ours=${ours.length}, CLI=${theirs.length})`)
    }
    for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
      diffs.push(...diffObjects(ours[i], theirs[i], label, `${path}[${i}]`))
    }
    return diffs
  }

  const allKeys = new Set([...Object.keys(ours), ...Object.keys(theirs)])
  for (const key of allKeys) {
    const p = path ? `${path}.${key}` : key
    if (!(key in ours)) {
      diffs.push(`${p}: missing in ours (CLI has ${JSON.stringify(theirs[key])})`)
    } else if (!(key in theirs)) {
      diffs.push(`${p}: extra in ours (value=${JSON.stringify(ours[key])})`)
    } else {
      diffs.push(...diffObjects(ours[key], theirs[key], label, p))
    }
  }

  return diffs
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
