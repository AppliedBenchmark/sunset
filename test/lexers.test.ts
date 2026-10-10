import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Lexer } from '../src/core/ports.ts';
import { LEXERS, lexerFor } from '../src/core/scan/lexers/index.ts';
import { ipythonLexer } from '../src/core/scan/lexers/ipython.ts';
import type { Language, Span } from '../src/core/types.ts';

/** `kind:text` for each span, with `~` marking interpolated string segments. */
function spans(language: Language | Lexer, text: string): string[] {
  return (typeof language === 'string' ? lexerFor(language) : language)
    .lex(text)
    .map((s) => `${s.kind[0]}${s.interpolated ? '~' : ''}:${text.slice(s.start, s.end)}`);
}

describe('c-like lexers', () => {
  it.each<[Language, string, string[]]>([
    ['javascript', `a = "x" + 'y' // c "z"`, ['s:x', 's:y', 'c:// c "z"']],
    ['javascript', '/* "a" */ b("c")', ['c:/* "a" */', 's:c']],
    ['javascript', 'f(`a${g(`b${"c"}d`)}e`)', ['s~:a', 's~:b', 's:c', 's~:d', 's~:e']],
    ['javascript', 'x = /"[/]"/g; y = "real"', ['s:real']],
    ['javascript', 'a = b / c / "d"', ['s:d']],
    // A `'` right after a letter can't open a JS string, so JSX text like this is safe.
    ['javascript', "const t = <p>Don't</p>; const m = 'gpt'", ['s:gpt']],
    // A backtick or `"` right after a word does: a tagged template, or minified code.
    [
      'javascript',
      'const url = path`/threads/${id}`; // gpt-x\nconst m = "y"',
      ['s~:/threads/', 's~:', 'c:// gpt-x', 's:y'],
    ],
    [
      'javascript',
      'sql`SELECT 1` + gql`{ a }` + css`color: red` // c',
      ['s:SELECT 1', 's:{ a }', 's:color: red', 'c:// c'],
    ],
    [
      'javascript',
      'String.raw`C:\\dir` + a.b.tag`x` + f()`y` + t[0]`z` // c',
      ['s:C:\\dir', 's:x', 's:y', 's:z', 'c:// c'],
    ],
    ['javascript', 'if(a)return"x";else return`y` // c', ['s:x', 's:y', 'c:// c']],
    // A hashbang line is a comment; in Rust, `#![…]` is an attribute instead.
    [
      'javascript',
      "#!/usr/bin/env -S node --title='gpt-x'\nconst m = 'y'",
      ["c:#!/usr/bin/env -S node --title='gpt-x'", 's:y'],
    ],
    ['rust', '#![doc = "a"]\nfn f() {}', ['s:a']],
    // A JSX closing tag, or `/>` after an attribute's `}`, doesn't start a regex.
    [
      'javascript',
      '<label>Model</label><select defaultValue="gpt-x" /> // c',
      ['s:gpt-x', 'c:// c'],
    ],
    ['javascript', '<Icon size={16}/><Badge model="claude-x" />', ['s:claude-x']],
    ['javascript', 'return <></>; // c', ['c:// c']],
    ['javascript', 'if (a) {}\n/"q"/.test(s)', []],
    ['javascript', 'x = "unterminated\ny = "ok"', ['s:unterminated', 's:ok']],
    ['go', 'x := `raw "q"\nline` + "s" // c', ['s:raw "q"\nline', 's:s', 'c:// c']],
    // Only JavaScript opens literals right after a word; Kotlin and Scala quote identifiers in backticks.
    ['go', "f(`a`) // don't", ['s:a', "c:// don't"]],
    ['kotlin', 'fun `don\'t fail`() { val m = "x" }', ['s:x']],
    ['scala', 'val `type` = "x"; val y = s"$x"', ['s:x', 's~:', 's~:']],
    ['rust', 'let s = r#"a "b" c"#; let l: &\'a str = "x";', ['s:a "b" c', 's:x']],
    [
      'rust',
      'let c = \'"\'; /* a /* nested */ b */ "y"',
      ['s:"', 'c:/* a /* nested */ b */', 's:y'],
    ],
    ['rust', 'b"bytes" br##"raw"##', ['s:bytes', 's:raw']],
    [
      'csharp',
      'var a = @"C:\\path ""q"""; var b = $"x{y}z";',
      ['s:C:\\path ""q""', 's~:x', 's~:z'],
    ],
    [
      'csharp',
      'var r = """\n  raw "x"\n  """; var i = $$"""a{{b}}c""";',
      ['s:\n  raw "x"\n  ', 's~:a', 's~:c'],
    ],
    ['csharp', 'var v = $@"a{b}"; var w = @$"c";', ['s~:a', 's~:', 's:c']],
    [
      'java',
      'String s = """\n  text "block"\n  """; char c = \'"\';',
      ['s:\n  text "block"\n  ', 's:"'],
    ],
    [
      'kotlin',
      'val s = "a$b c${d}e"; val r = """x $y"""',
      ['s~:a', 's~: c', 's~:e', 's~:x ', 's~:'],
    ],
    ['swift', 'let s = "a\\(b)c"; let r = #"raw "q""#', ['s~:a', 's~:c', 's:raw "q"']],
    ['swift', 'let m = """\nmulti\n"""', ['s:\nmulti\n']],
    ['c', 'auto s = R"d(a "b" c)d"; int n = 1\'000; char c = \'x\';', ['s:a "b" c', 's:x']],
    ['c', 'auto u = u8"utf"; auto w = L"wide";', ['s:utf', 's:wide']],
    [
      'php',
      "<p>Don't</p><?php $a = 'x'; $b = \"y $c z\"; # c\n?><p>'</p>",
      ['s:x', 's~:y ', 's~: z', 'c:# c'],
    ],
    [
      'php',
      '<?php $h = <<<EOT\n  a "b" {$c}\n  EOT;\n$n = <<<\'EOT\'\nraw $x\nEOT;',
      ['s~:  a "b" ', 's~:\n', 's:raw $x\n'],
    ],
    [
      'scala',
      'val s = s"a$b"; val r = raw"x\\y"; val t = """q"""',
      ['s~:a', 's~:', 's:x\\y', 's:q'],
    ],
    ['dart', "var s = 'a$b'; var r = r'$raw'; var m = '''x''';", ['s~:a', 's~:', 's:$raw', 's:x']],
    [
      'bicep',
      "var s = 'a${b}c'\nvar m = '''\nmulti 'q'\n'''\nvar d = \"not a string\"",
      ['s~:a', 's~:c', "s:\nmulti 'q'\n"],
    ],
  ])('%s: %s', (language, text, expected) => {
    expect(spans(language, text)).toEqual(expected);
  });

  it('marks earlier segments of an interpolated literal too', () => {
    const lexed = lexerFor('javascript').lex('x = `a${b}c`');
    expect(lexed.map((s) => s.interpolated)).toEqual([true, true]);
    expect(new Set(lexed.map((s) => s.open))).toEqual(new Set([4]));
  });
});

describe('python lexer', () => {
  it.each<[string, string[]]>([
    ['x = "a" # "c"', ['s:a', 'c:# "c"']],
    ["s = '''multi\n'line'''", ["s:multi\n'line"]],
    ['r = rb"\\d" + Rb\'x\'', ['s:\\d', 's:x']],
    ['f = f"a{b}c{{d}}"', ['s~:a', 's~:c{{d}}']],
    ['n = f"x{f"y{z}"}w"', ['s~:x', 's~:y', 's~:', 's~:w']],
    ['d = f"{d["k"]!r:>10}"', ['s~:', 's:k', 's~:']],
    ['t = """a\n"b"\n"""', ['s:a\n"b"\n']],
    ['u = "unterminated\nv = "ok"', ['s:unterminated', 's:ok']],
    // Docstrings and other bare triple-quoted statements are documentation.
    ['def f():\n    """Uses gpt-x."""\n    x = """y"""', ['c:"""Uses gpt-x."""', 's:y']],
    ["'''module doc'''  # c\nz = 1", ["c:'''module doc'''", 'c:# c']],
    ['call("""\narg\n""")', ['s:\narg\n']],
    // Alone on its line but inside brackets or after a `\` continuation, it is part of a statement.
    [
      'c = load(\n    """\n    model: x\n    """\n)\nl = [\n    """y"""\n]\nz = 1 + \\\n    """w"""',
      ['s:\n    model: x\n    ', 's:y', 's:w'],
    ],
    // The brackets of an f-string's interpolations balance, strings in them aside.
    ['s = f"{d[\'k\']}"\n"""doc"""', ['s~:', 's:k', 's~:', 'c:"""doc"""']],
  ])('%s', (text, expected) => {
    expect(spans('python', text)).toEqual(expected);
  });
});

describe('hash lexers', () => {
  it.each<[Language, string, string[]]>([
    [
      'shell',
      'export MODEL=gpt # c\necho "a $B" \'c\'',
      ['v:export', 'v:MODEL=gpt', 'c:# c', 'v:echo', 's~:a $B', 's:c'],
    ],
    ['shell', 'x=a#b; y="$(cmd "q")z"', ['v:x=a#b', 'v:y=', 's~:', 's~:z']],
    // The word of a default or alternate value is a literal, even with quotes in it.
    [
      'shell',
      'a="x${M:-gpt-x}" b="${1-"y"}" c="${N:=z${O:+w}}" d="${P:?message}"',
      [
        'v:a=',
        's~:x',
        's~:gpt-x',
        's~:',
        'v:b=',
        's~:',
        's~:"y"',
        's~:',
        'v:c=',
        's~:',
        's~:z',
        's~:w',
        's~:',
        's~:',
        'v:d=',
        's~:',
        's~:',
      ],
    ],
    [
      'shell',
      'cat <<EOF > f\nmodel: gpt\nEOF\necho done',
      ['v:cat', 'v:f', 'v:model: gpt\n', 'v:echo', 'v:done'],
    ],
    ['shell', "cat <<'EOF'\n$literal\nEOF", ['v:cat', 'v:$literal\n']],
    // Blanks before the word and any quoting in it, as bash, dash and zsh read them.
    ['shell', "cat << 'EOF' > f\nDon't\nEOF\n# c", ['v:cat', 'v:f', "v:Don't\n", 'c:# c']],
    [
      'shell',
      'cat <<\\EOF\n$a\nEOF\ncat <<- E"O"F\n\t$b\n\tEOF\n# c',
      ['v:cat', 'v:$a\n', 'v:cat', 'v:\t$b\n', 'c:# c'],
    ],
    // `<<` is a shift in arithmetic, and taken for one before a digit. `<<<` is a here-string.
    [
      'shell',
      'a=$((1<<20)) b=$(( (1 << 4) ))\n(( c <<= 1 ))\nSIZE=1<<20\n# c',
      [
        'v:a=$',
        'v:1',
        'v:20',
        'v:b=$',
        'v:1',
        'v:4',
        'v:c',
        'v:=',
        'v:1',
        'v:SIZE=1',
        'v:20',
        'c:# c',
      ],
    ],
    ['shell', 'cat <<< "$x" # c', ['v:cat', 's~:$x', 'c:# c']],
    [
      'shell',
      'ENV MODEL gpt-x\nRUN python run.py --model "$M"',
      ['v:ENV', 'v:MODEL', 'v:gpt-x', 'v:RUN', 'v:python', 'v:run.py', 'v:--model', 's~:$M'],
    ],
    [
      'toml',
      'model = "gpt" # c\nlist = [\'a\', "b"]\nm = """x\ny"""',
      ['v:model', 's:gpt', 'c:# c', 'v:list', 's:a', 's:b', 'v:m', 's:x\ny'],
    ],
    [
      'ini',
      '; comment\n[s]\nmodel = gpt ; trailing\n# hash',
      ['c:; comment', 'v:[s]', 'v:model', 'v:gpt', 'c:; trailing', 'c:# hash'],
    ],
    // Java properties: `!` starts a comment only first on its line.
    ['ini', '! c\n  !d\nmodel=gpt!x !y', ['c:! c', 'c:!d', 'v:model', 'v:gpt!x', 'v:!y']],
    ['ruby', 'm = "a#{b}c" # c\nn = \'d\'', ['s~:a', 's~:c', 'c:# c', 's:d']],
    // Heredocs: the body starts on the next line; a lowercase bare word after `<<` is appended.
    [
      'ruby',
      "a = <<~ONE\n  it's #{x} a\nONE\nb = <<-'RAW'\n  #{raw}\n  RAW\nc <<\"y\" # d",
      ["s~:  it's ", 's~: a\n', 's:  #{raw}\n', 's:y', 'c:# d'],
    ],
    // Percent literals, whose paired delimiters nest; after an operand `%` is the modulo operator.
    [
      'ruby',
      'w = %w[a [b] c] + %i(d) + %q{e {f}} + %Q<g #{h}> + %(i) # c\nk = x %(3) ; l %= 2 ; /<%\\s*"/',
      // `%w` and `%i` are lists of words: each word is its own string.
      ['s:a', 's:[b]', 's:c', 's:d', 's:e {f}', 's~:g ', 's~:', 's:i', 'c:# c', 's:/'],
    ],
    [
      'r',
      // A raw string ends at its delimiter, dashes and quote: `)"` here, `]--'` after.
      "m <- 'it\\'s' # c\nq <- \"a\nb\" ; r\"(x \") y)\" ; R'--[a]-' ]--' ; `don't`",
      ["s:it\\'s", 'c:# c', 's:a\nb', 's:x ") y', "s:a]-' "],
    ],
    [
      'powershell',
      "$m = 'it''s' # c\n<# a 'b'\n#> az --model-name gpt-x `\n  -v 1 Foo#Bar",
      [
        'v:$m',
        "s:it''s",
        'c:# c',
        "c:<# a 'b'\n#>",
        'v:az',
        'v:--model-name',
        'v:gpt-x',
        'v:-v',
        'v:1',
        'v:Foo#Bar',
      ],
    ],
    [
      'powershell',
      '"a `"b`" ""c"" $env:M $(Get-X "y") ${n} d"',
      ['s~:a `"b`" ""c"" $env:M ', 's~: ', 's~: d'],
    ],
    // Here-strings end at a line that starts with the closing mark.
    [
      'powershell',
      '$a =@\'\nit\'s $x\n\'@\n@"\n$y "q"\n  "@\n"@ | Out-Null',
      ['v:$a', "s:it's $x", 's~:$y "q"\n  "@', 'v:Out-Null'],
    ],
  ])('%s: %s', (language, text, expected) => {
    expect(spans(language, text)).toEqual(expected);
  });
});

describe('yaml lexer', () => {
  it.each<[string, string[]]>([
    ['model: gpt-x # c', ['v:model', 'v:gpt-x', 'c:# c']],
    ["- \"a: b\"\n- 'it''s'", ['s:a: b', "s:it''s"]],
    ['k: [a, "b", {c: d}]', ['v:k', 'v:a', 's:b', 'v:c', 'v:d']],
    ['text: |\n  a b\n  c\nnext: x', ['v:text', 'v:  a b\n  c', 'v:next', 'v:x']],
    // In a block scalar, a line starting with `#` is a comment of the script or config it holds.
    [
      'config: |\n  a: 1\n  # c\n\n  b: 2 # d\n  #e\nnext: x',
      ['v:config', 'v:  a: 1', 'c:# c', 'v:\n  b: 2 # d', 'c:#e', 'v:next', 'v:x'],
    ],
    // A block scalar ends at a line indented no more than its key, after `- ` entries too.
    [
      '- name: s\n  text: |\n    a b\n  with: x\n- - k: |\n      c\n    j: y',
      ['v:name', 'v:s', 'v:text', 'v:    a b', 'v:with', 'v:x', 'v:k', 'v:      c', 'v:j', 'v:y'],
    ],
    // Under a key that holds commands, a value is lexed as shell: each word is a value.
    [
      'run: |\n  llm -m gpt-x "Sum it" # c\n  # d\nsteps:\n  - run: python e.py gpt-y\n    env: {A: b c}',
      [
        'v:run',
        'v:llm',
        'v:-m',
        'v:gpt-x',
        's:Sum it',
        'c:# c',
        'c:# d',
        'v:steps',
        'v:run',
        'v:python',
        'v:e.py',
        'v:gpt-y',
        'v:env',
        'v:A',
        'v:b c',
      ],
    ],
    // Its sequences and flow collections too, and quoted values; a nested key decides for itself.
    [
      'script:\n- echo a\n- |\n  e b\ncommand: [sh, -c, "exec llm c"]\nx: {cmd: d e, f: g h}',
      [
        'v:script',
        'v:echo',
        'v:a',
        'v:e',
        'v:b',
        'v:command',
        'v:sh',
        'v:-c',
        'v:exec',
        'v:llm',
        'v:c',
        'v:x',
        'v:cmd',
        'v:d',
        'v:e',
        'v:f',
        'v:g h',
      ],
    ],
    [
      'run:\n  shell: bash x\n  args: y z',
      ['v:run', 'v:shell', 'v:bash x', 'v:args', 'v:y', 'v:z'],
    ],
    ['s: >-\n  folded\n\n  text\n', ['v:s', 'v:  folded\n\n  text']],
    ['url: http://x/a#b', ['v:url', 'v:http://x/a#b']],
    ['---\nk: &a v\nl: *a\n...', ['v:k', 'v:v', 'v:l']],
    ['key: "multi\n  line"', ['v:key', 's:multi\n  line']],
  ])('%s', (text, expected) => {
    expect(spans('yaml', text)).toEqual(expected);
  });
});

describe('ipython lexer', () => {
  it.each<[string, string[]]>([
    // Shell commands and line magics, also assigned; `%time` takes Python code.
    [
      '!pip install x\n!python a.py --model gpt-x "q r"\nfiles = !ls d\n!!echo z\nout = %sx cat f\n%env M=gpt-y\n%run e.py gpt-z\n%time f("w")\nprint("v")',
      [
        'v:pip',
        'v:install',
        'v:x',
        'v:python',
        'v:a.py',
        'v:--model',
        'v:gpt-x',
        's:q r',
        'v:ls',
        'v:d',
        'v:echo',
        'v:z',
        'v:cat',
        'v:f',
        'v:M=gpt-y',
        'v:e.py',
        'v:gpt-z',
        's:w',
        's:v',
      ],
    ],
    // Only where a statement starts: also indented, but not in a string, in brackets, after a `\`
    // continuation or a comparison.
    [
      'for f in fs:\n    !echo {f} gpt-x\ns = """\n!a\n"""\nx = (1\n     % 2, "y")\nz = 1 + \\\n!q\na = b == !c\nif a != !e: pass  # !d',
      ['v:echo', 'v:{f}', 'v:gpt-x', 's:\n!a\n', 's:y', 'c:# !d'],
    ],
    // A command runs on through lines that end in `\`.
    ['!echo a \\\n  b\nc = "d"', ['v:echo', 'v:a', 'v:\\\n', 'v:b', 's:d']],
    // A cell magic, after blank lines: the rest of the cell in its program's language.
    ['\n  %%bash\necho gpt-x "a b" # c', ['v:echo', 'v:gpt-x', 's:a b', 'c:# c']],
    ['%%script --bg --out o /usr/bin/ruby\nputs "x" # c', ['s:x', 'c:# c']],
    ['%%js\nconst m = "gpt-x" // c', ['s:gpt-x', 'c:// c']],
    // `%%writefile`: in the language of the path, or one value.
    [
      '%%writefile cfg.yaml\nrun: python e.py gpt-x\nmodel: y',
      ['v:run', 'v:python', 'v:e.py', 'v:gpt-x', 'v:model', 'v:y'],
    ],
    ['%%writefile -a "notes.txt"\nUse gpt-x here.\n\n', ['v:Use gpt-x here.']],
    ['%%file app.py\n"""Doc."""\n!m = "x"', ['c:"""Doc."""', 's:x']],
    // `%%time` and the like run the rest as a cell; `%%timeit` takes a setup statement.
    ['%%timeit -n 1 g("y")\n%%capture\n!ls gpt-x\n%time h("w")', ['s:y', 'v:ls', 'v:gpt-x', 's:w']],
    ['%%capture out\n%%bash\nllm -m gpt-x', ['v:llm', 'v:-m', 'v:gpt-x']],
    // Other cell magics keep the Python reading, as does `%%script` without a program.
    ['%%sql\nSELECT "gpt-x" -- \'c\'', ['s:gpt-x', 's:c']],
    ['%%script --bg\nputs "x"', ['s:x']],
    ['%%bash', []],
    ['%%writefile\n  \n', []],
    // A `\` before a CRLF line break continues the statement too.
    ['x = 1 + \\\r\n!q\r\n!r', ['v:r']],
  ])('%s', (text, expected) => {
    expect(spans(ipythonLexer, text)).toEqual(expected);
  });
});

describe('lua lexer', () => {
  it.each<[string, string[]]>([
    ["m = 'a' -- c 'q'\nn = \"b\\\"c\" .. require'd'", ['s:a', "c:-- c 'q'", 's:b\\"c', 's:d']],
    // The interpreter skips a first line that starts with `#`.
    ["#!/usr/bin/env lua 'x'\nm = 'a'", ["c:#!/usr/bin/env lua 'x'", 's:a']],
    // Long brackets of any level, for strings and comments; a line break right after the opening
    // bracket isn't part of the string.
    [
      '--[==[ x ]] y ]==] s = [[\nlong "q"]] .. [=[a]]b]=]',
      ['c:--[==[ x ]] y ]==]', 's:long "q"', 's:a]]b'],
    ],
    // A short string ends at an unescaped line break; `\z` skips the blanks after it.
    ["a = 'open\nb = 'x\\\ny' .. 'p\\z\n  q'", ['s:open', 's:x\\\ny', 's:p\\z\n  q']],
  ])('%s', (text, expected) => {
    expect(spans('lua', text)).toEqual(expected);
  });
});

describe('html lexer', () => {
  it.each<[string, string[]]>([
    // Comments and attribute values; text is prose, and `<style>` has no spans.
    [
      '<!-- c --><option value="gpt-x" data-a=\'y\' b=z>Don\'t "q"</option><style>a { b: "s" }</style>',
      ['c:<!-- c -->', 's:gpt-x', 's:y', 'v:z'],
    ],
    // Script contents are JavaScript, up to the first `</script`, in any case.
    ['<SCRIPT lang="ts">x = "</p>" // c\n</Script >', ['s:ts', 's:</p>', 'c:// c']],
    // Svelte and Astro: `{…}` attribute values, and Astro's component script.
    ["---\nconst m = 'a';\n---\n<C m={'b'} {...p} t=\"{c}\" />", ['s:a', 's:b', 's:{c}']],
  ])('%s', (text, expected) => {
    expect(spans('html', text)).toEqual(expected);
  });

  it('lexes a script with more strings than a call can take arguments', () => {
    const text = `<script>${'"a",'.repeat(200_000)}</script>`;
    expect(lexerFor('html').lex(text)).toHaveLength(200_000);
  });
});

describe('json and hcl lexers', () => {
  it.each<[Language, string, string[]]>([
    [
      'json',
      '{"model": "gpt", // c\n "e": "a\\"b"}',
      ['s:model', 's:gpt', 'c:// c', 's:e', 's:a\\"b'],
    ],
    [
      'hcl',
      'a = "x${var.y}z" # c\nb = <<-EOT\n  heredoc ${q}\n  EOT\nc = "$${lit}"',
      ['s~:x', 's~:z', 'c:# c', 's~:  heredoc ', 's~:\n', 's:$${lit}'],
    ],
    ['hcl', '/* a */ b = "c" // d', ['c:/* a */', 's:c', 'c:// d']],
    // A heredoc that is a script, by its attribute or a `#!` line, is lexed as shell.
    [
      'hcl',
      'p = <<EOF\n{"a": "x y"}\nEOF\nuser_data = base64encode(<<-EOF\n  run ${var.m} gpt-x\n  EOF\n)\ninline = [<<-EOT\n  llm -m y # c\nEOT\n]\nd = <<-EOT\n  #!/bin/sh\n  z w\n  EOT',
      [
        's:{"a": "x y"}\n',
        'v:run',
        'v:${var.m}',
        'v:gpt-x',
        'v:llm',
        'v:-m',
        'v:y',
        'c:# c',
        'c:#!/bin/sh',
        'v:z',
        'v:w',
      ],
    ],
    // JSON5: single-quoted strings, which may continue on the next line after a backslash.
    [
      'json',
      "{model: 'gpt-x', // c\n note: 'it\\'s \"q\"', s: 'a\\\nb'}",
      ['s:gpt-x', 'c:// c', 's:it\\\'s "q"', 's:a\\\nb'],
    ],
    // JSON Lines: a value on each line.
    ['json', '{"model": "a"}\n{"model": "b"}\n', ['s:model', 's:a', 's:model', 's:b']],
  ])('%s: %s', (language, text, expected) => {
    expect(spans(language, text)).toEqual(expected);
  });
});

describe('every lexer (properties)', () => {
  const lexers: [string, Lexer][] = [
    ...LEXERS.flatMap((l) => l.languages.map((language): [string, Lexer] => [language, l])),
    ['ipython', ipythonLexer],
  ];
  const alphabet = [
    ...'"\'`/*#\\${}()[]<>@rRbfu=:;-|!?%\n \t'.split(''),
    'R"x(',
    ')x"',
    '"""',
    "'''",
    '<<EOT\n',
    '\nEOT\n',
    '<?php',
    '?>',
    '%%bash\n',
    'run: |\n',
    'user_data = <<A\n',
    'a',
    'gpt-4o',
  ];
  const source = fc
    .array(fc.oneof(fc.constantFrom(...alphabet), fc.string({ maxLength: 3 })), { maxLength: 60 })
    .map((parts) => parts.join(''));

  const checkSpans = (text: string, out: readonly Span[]): void => {
    let previousEnd = 0;
    for (const span of out) {
      expect(span.start).toBeGreaterThanOrEqual(previousEnd);
      expect(span.end).toBeGreaterThanOrEqual(span.start);
      expect(span.end).toBeLessThanOrEqual(text.length);
      previousEnd = span.end;
    }
  };

  it.each(lexers)(
    '%s: spans are sorted, non-overlapping and in bounds; it never throws',
    (_, lexer) => {
      fc.assert(
        fc.property(source, (text) => checkSpans(text, lexer.lex(text))),
        { numRuns: 300 },
      );
    },
  );

  // One long line of the same opener: each must be lexed without searching the rest of the text.
  it.each<[Language, string]>([
    ['c', 'R"'],
    ['python', '"'],
    ['php', '<?php <<<A '],
    ['hcl', '<<A '],
    ['hcl', '<<~A '],
    ['shell', '"${A:-'],
    ['shell', '"$(a)'],
  ])('%s: stays linear on a long line of %j', (language, unit) => {
    const lexer = lexerFor(language);
    const time = (count: number): number => {
      const text = unit.repeat(count);
      const started = performance.now();
      checkSpans(text, lexer.lex(text));
      return performance.now() - started;
    };
    const count = Math.ceil(400_000 / unit.length);
    const small = time(count / 8);
    const large = time(count);
    // Linear: 8× the input costs about 8× the time; quadratic would be 64×.
    expect(large).toBeLessThan(Math.max(100, small * 24));
  });

  it.each(lexers)('%s: stays linear on adversarial input', (name, lexer) => {
    const n = 40_000;
    const inputs = [
      '"'.repeat(n),
      "'".repeat(n),
      '`${'.repeat(n / 3),
      'f"{'.repeat(n / 3),
      '/*'.repeat(n / 2),
      '<<EOT\n'.repeat(n / 6),
      "<<'a'".repeat(n / 5),
      '$(('.repeat(n / 3),
      '<a b={'.repeat(n / 6),
      '<a b="'.repeat(n / 6),
      '<script>'.repeat(n / 8),
      '{'.repeat(n),
      '$"{'.repeat(n / 3),
      `"${'\\'.repeat(n)}`,
      'a: [b, {c: '.repeat(n / 10),
      `r${'#'.repeat(n)}"`,
      'R"'.repeat(n / 2),
      '!a\n'.repeat(n / 3),
      '%%time\n'.repeat(n / 7),
      'x = (\n%a\n'.repeat(n / 9),
      '"""\n!a\n'.repeat(n / 6),
      '- run: |\n    a\n'.repeat(n / 16),
      'a:\n'.repeat(n / 3),
      'user_data = <<A\nx\nA\n'.repeat(n / 20),
    ];
    const time = (text: string): number => {
      const started = performance.now();
      checkSpans(text, lexer.lex(text));
      return performance.now() - started;
    };
    for (const text of inputs) {
      const small = time(text.slice(0, text.length / 4));
      const large = time(text);
      // Linear: 4× the input costs about 4× the time; quadratic would be 16×.
      expect(large, `${name} on ${JSON.stringify(text.slice(0, 12))}…`).toBeLessThan(
        Math.max(250, small * 12),
      );
    }
  });
});
