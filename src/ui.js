/**
 * Terminal UI and Formatting Helpers
 * Uses standard ANSI escape codes for cross-platform zero-dependency formatting.
 */

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m'
};

function colorize(color, text) {
  if (process.env.NO_COLOR !== undefined) {
    return text;
  }
  if (!process.stdout.isTTY && !process.env.FORCE_COLOR) {
    return text;
  }
  return `${colors[color] || ''}${text}${colors.reset}`;
}

const c = {
  green: (t) => colorize('green', t),
  red: (t) => colorize('red', t),
  yellow: (t) => colorize('yellow', t),
  blue: (t) => colorize('blue', t),
  magenta: (t) => colorize('magenta', t),
  cyan: (t) => colorize('cyan', t),
  gray: (t) => colorize('gray', t),
  bold: (t) => colorize('bold', t),
  dim: (t) => colorize('dim', t)
};

/**
 * Formats a status badge with icon and color
 */
function formatStatus(status) {
  switch (status) {
    case 'CONNECTED':
      return c.green('● CONNECTED');
    case 'CONNECTING':
      return c.yellow('◌ CONNECTING');
    case 'STOPPED':
      return c.gray('○ STOPPED');
    case 'ERROR':
      return c.red('✖ ERROR');
    default:
      return status;
  }
}

/**
 * Format milliseconds into human-readable duration
 */
function formatUptime(ms) {
  if (!ms || ms <= 0) return '-';
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Render a formatted text table with borders
 * @param {string[]} headers 
 * @param {Array<string[]>} rows 
 * @returns {string}
 */
function formatTable(headers, rows) {
  // Calculate column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const val = row[i] ? stripAnsi(String(row[i])) : '';
      if (val.length > max) max = val.length;
    }
    return max + 2; // padding
  });

  const horizontalLine = (left, mid, cross, right) => {
    return left + widths.map((w) => '─'.repeat(w)).join(cross) + right;
  };

  const topBorder = horizontalLine('┌', '─', '┬', '┐');
  const midBorder = horizontalLine('├', '─', '┼', '┤');
  const bottomBorder = horizontalLine('└', '─', '┴', '┘');

  const formatRow = (cells, isHeader = false) => {
    const paddedCells = headers.map((_, idx) => cells[idx] ?? '');
    const formatted = paddedCells.map((cell, idx) => {
      const str = String(cell ?? '');
      const visibleLen = stripAnsi(str).length;
      const colWidth = widths[idx] || (visibleLen + 2);
      const padLen = Math.max(0, colWidth - visibleLen - 1);
      return ' ' + str + ' '.repeat(padLen);
    });
    return '│' + formatted.join('│') + '│';
  };

  const lines = [
    topBorder,
    formatRow(headers.map((h) => c.bold(h)), true),
    midBorder,
    ...rows.map((r) => formatRow(r)),
    bottomBorder
  ];

  return lines.join('\n');
}

/**
 * Strip ANSI escape codes for width calculations
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

module.exports = {
  colors,
  c,
  formatStatus,
  formatUptime,
  formatTable,
  stripAnsi
};
