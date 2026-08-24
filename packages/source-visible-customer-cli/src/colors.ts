// Dependency-free ANSI styler with a chalk-compatible surface, imported as
// `chalk` at call sites. Color gating (NO_COLOR / FORCE_COLOR / non-TTY) lives
// in colorEnabled() below.

const STYLE_NAMES = ['bold', 'dim', 'red', 'green', 'yellow', 'cyan'] as const;
type StyleName = (typeof STYLE_NAMES)[number];

// SGR open/close codes. Bold and dim share the 22 reset; colors share 39, so a
// nested inner style restores exactly its own attribute without clearing the
// outer one.
const OPEN: Record<StyleName, string> = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const CLOSE: Record<StyleName, string> = {
  bold: '\x1b[22m',
  dim: '\x1b[22m',
  red: '\x1b[39m',
  green: '\x1b[39m',
  yellow: '\x1b[39m',
  cyan: '\x1b[39m',
};

function colorEnabled(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force !== 'false';
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

function applyStyle(name: StyleName, text: string): string {
  const open = OPEN[name];
  const close = CLOSE[name];
  // Re-open this style after any inner close of the same code, so a nested
  // style (e.g. chalk.red(`a ${chalk.bold('b')} c`)) doesn't terminate it early.
  const body = text.includes(close) ? text.split(close).join(close + open) : text;
  return open + body + close;
}

export type Styler = ((text: string) => string) & {
  [K in StyleName]: Styler;
};

function createStyler(styles: StyleName[]): Styler {
  const fn = ((text: string): string => {
    const value = String(text);
    if (!colorEnabled() || styles.length === 0) return value;
    // Apply right-to-left so the first style in the chain is outermost.
    return styles.reduceRight((acc, name) => applyStyle(name, acc), value);
  }) as Styler;

  for (const name of STYLE_NAMES) {
    Object.defineProperty(fn, name, {
      configurable: true,
      enumerable: false,
      get: () => createStyler([...styles, name]),
    });
  }
  return fn;
}

const colors = createStyler([]);
export default colors;
