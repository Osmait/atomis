import type * as Monaco from "monaco-editor";

function cFamilyMonarch(cpp: boolean): Monaco.languages.IMonarchLanguage {
	return {
		defaultToken: "",
		tokenPostfix: cpp ? ".cpp" : ".c",
		keywords: [
			"auto",
			"break",
			"case",
			"const",
			"continue",
			"default",
			"do",
			"else",
			"enum",
			"extern",
			"for",
			"goto",
			"if",
			"inline",
			"register",
			"restrict",
			"return",
			"sizeof",
			"static",
			"struct",
			"switch",
			"typedef",
			"union",
			"volatile",
			"while",
			"_Generic",
			...(cpp
				? [
						"alignas",
						"alignof",
						"catch",
						"class",
						"concept",
						"constexpr",
						"consteval",
						"constinit",
						"co_await",
						"co_return",
						"co_yield",
						"decltype",
						"delete",
						"explicit",
						"export",
						"false",
						"friend",
						"mutable",
						"namespace",
						"new",
						"noexcept",
						"nullptr",
						"operator",
						"private",
						"protected",
						"public",
						"requires",
						"template",
						"this",
						"throw",
						"true",
						"try",
						"typename",
						"using",
						"virtual",
					]
				: ["_Bool"]),
		],
		typeKeywords: [
			"bool",
			"char",
			"double",
			"float",
			"int",
			"long",
			"short",
			"signed",
			"unsigned",
			"void",
			"size_t",
			"int8_t",
			"int16_t",
			"int32_t",
			"int64_t",
			"uint8_t",
			"uint16_t",
			"uint32_t",
			"uint64_t",
			...(cpp ? ["auto", "string", "wchar_t", "char8_t", "char32_t"] : []),
		],
		operators: [],
		tokenizer: {
			root: [
				[/^\s*#\s*\w+/, "predefined"],
				[/\/\/.*/, "comment"],
				[/\/\*/, "comment", "@blockComment"],
				[/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
				[/'([^'\\]|\\.)+'/, "string"],
				[
					/[A-Za-z_]\w*/,
					{
						cases: {
							"@keywords": "keyword",
							"@typeKeywords": "type",
							"@default": "identifier",
						},
					},
				],
				[/0[xX][0-9a-fA-F]('?[0-9a-fA-F])*[uUlL]*/, "number.hex"],
				[/0[bB][01]('?[01])*[uUlL]*/, "number.binary"],
				[
					/(\d('?\d)*\.?(\d('?\d)*)?|\.\d('?\d)*)([eE][+-]?\d+)?[fFuUlL]*/,
					"number",
				],
				[/[{}()[\]]/, "@brackets"],
				[/[;,.]/, "delimiter"],
				[/[=><!~?:&|+\-*/%^]+/, "operator"],
			],
			blockComment: [
				[/[^/*]+/, "comment"],
				[/\*\//, "comment", "@pop"],
				[/[/*]/, "comment"],
			],
			string: [
				[/[^\\"]+/, "string"],
				[/\\./, "string.escape"],
				[/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
			],
		},
	};
}

/** Registers both the C and C++ Monaco languages. */
export function registerC(monaco: typeof Monaco): void {
	for (const [id, cpp, extensions] of [
		["c", false, [".c", ".h"]],
		["cpp", true, [".cpp", ".cc", ".hpp"]],
	] as const) {
		monaco.languages.register({ id, extensions: [...extensions] });
		monaco.languages.setMonarchTokensProvider(id, cFamilyMonarch(cpp));
		monaco.languages.setLanguageConfiguration(id, {
			comments: { lineComment: "//", blockComment: ["/*", "*/"] },
			brackets: [
				["{", "}"],
				["[", "]"],
				["(", ")"],
			],
			autoClosingPairs: [
				{ open: "{", close: "}" },
				{ open: "[", close: "]" },
				{ open: "(", close: ")" },
				{ open: '"', close: '"' },
			],
		});
	}
}
