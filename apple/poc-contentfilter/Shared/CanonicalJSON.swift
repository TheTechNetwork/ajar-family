import Foundation

/// Deterministic JSON serialization — the Swift mirror of
/// `backend/src/util/canonical.ts`:
///
/// ```ts
/// export function canonicalJSON(value: unknown): string {
///   return JSON.stringify(sortKeys(value));
/// }
/// function sortKeys(value: unknown): unknown {
///   if (Array.isArray(value)) return value.map(sortKeys);
///   if (value && typeof value === "object") {
///     const out = {};
///     for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
///     return out;
///   }
///   return value;
/// }
/// ```
///
/// These are the exact bytes the backend signs. If this file and that file
/// disagree by ONE byte, every snapshot fails verification and (because we fail
/// closed) the device stops trusting its policy. This is the single highest-risk
/// piece of the Apple port; `PolicySelfTest` pins it against a real
/// backend-produced signature.
///
/// ## Why not JSONSerialization / JSONEncoder `.sortedKeys`
///
/// Foundation's `.sortedKeys` does NOT sort by code unit — it sorts with a
/// case-insensitive, diacritic-insensitive, numeric-aware comparison. JS
/// `Array.prototype.sort()` with no comparator sorts by UTF-16 code unit. For
/// ASCII keys that differ only in case ("Version" vs "version") the two orders
/// diverge, so `.sortedKeys` is unusable here and the sort is done explicitly.
/// Re-encoding a decoded `Codable` model is also unusable: it would re-format
/// dates and drop unknown fields, changing the signed bytes. So the RAW bytes as
/// delivered are parsed and re-emitted.
///
/// ## Deliberate divergences (all fail CLOSED, never open)
///
/// * Non-integral numbers and integers outside ±2^53 throw. JS
///   `Number::toString` for those is a shortest-round-trip algorithm whose exact
///   output (exponent form, "1e+21" thresholds) is easy to get subtly wrong, and
///   the snapshot/filter schemas contain no such numbers (`version`, `priority`,
///   `m`, `k`, `n` are all small integers). Better to reject than to sign off on
///   arithmetic that cannot be tested here.
/// * A lone surrogate escape (`\uD800` with no pair) throws instead of being
///   replaced with U+FFFD, which is what `JSONSerialization` would silently do.
///
/// NOT COMPILED OR RUN.
public enum CanonicalJSON {

    public enum Error: Swift.Error, CustomStringConvertible {
        case unexpectedEnd
        case unexpectedByte(UInt8, at: Int)
        case invalidNumber(String)
        case unsupportedNumber(String)
        case invalidEscape(at: Int)
        case loneSurrogate(at: Int)
        case invalidUTF8
        case trailingGarbage(at: Int)
        case depthExceeded
        case notAnObject

        public var description: String {
            switch self {
            case .unexpectedEnd: return "unexpected end of JSON"
            case let .unexpectedByte(b, i): return "unexpected byte 0x\(String(b, radix: 16)) at \(i)"
            case let .invalidNumber(s): return "invalid number literal '\(s)'"
            case let .unsupportedNumber(s):
                return "number '\(s)' is not an integer in ±2^53; canonicalization refuses it (see file header)"
            case let .invalidEscape(i): return "invalid string escape at \(i)"
            case let .loneSurrogate(i): return "lone UTF-16 surrogate at \(i)"
            case .invalidUTF8: return "input is not valid UTF-8"
            case let .trailingGarbage(i): return "trailing bytes after the JSON value at \(i)"
            case .depthExceeded: return "JSON nesting too deep"
            case .notAnObject: return "expected a JSON object at the top level"
            }
        }
    }

    // MARK: - Value

    /// A parsed JSON value. Numbers keep their source lexeme so the emitter can
    /// reason about them; objects keep insertion order only until the emitter
    /// sorts them.
    public indirect enum Value {
        case null
        case bool(Bool)
        case number(lexeme: String)
        case string(String)
        case array([Value])
        case object([String: Value])   // duplicate keys: last one wins, as JSON.parse does
    }

    // MARK: - Public entry points

    /// `canonicalJSON(JSON.parse(raw))` — parse, sort recursively, re-emit.
    public static func canonicalize(_ raw: Data) throws -> Data {
        let value = try parse(raw)
        return Data(try emit(value).utf8)
    }

    /// The snapshot signing bytes: `canonicalJSON({...snapshot, signature: undefined})`.
    /// The backend does `const { signature: _omit, ...rest } = snapshot`, i.e. it
    /// removes the key entirely (an `undefined` property is skipped by
    /// `JSON.stringify`), so the key is removed here rather than emptied.
    public static func canonicalizeObject(_ raw: Data, removingTopLevelKey key: String) throws -> Data {
        guard case .object(var fields) = try parse(raw) else { throw Error.notAnObject }
        fields.removeValue(forKey: key)
        return Data(try emit(.object(fields)).utf8)
    }

    /// Reads one top-level string field without trusting a `Codable` round trip
    /// (used for the `signature` field, which must come from the same bytes that
    /// are being canonicalized).
    public static func topLevelString(_ raw: Data, key: String) throws -> String? {
        guard case let .object(fields) = try parse(raw) else { throw Error.notAnObject }
        if case let .string(s)? = fields[key] { return s }
        return nil
    }

    // MARK: - Emit (mirror of JSON.stringify over sorted keys)

    public static func emit(_ value: Value) throws -> String {
        var out = String()
        out.reserveCapacity(1024)
        try emit(value, into: &out)
        return out
    }

    private static func emit(_ value: Value, into out: inout String) throws {
        switch value {
        case .null:
            out += "null"
        case let .bool(b):
            out += b ? "true" : "false"
        case let .number(lexeme):
            out += try canonicalNumber(lexeme)
        case let .string(s):
            emitString(s, into: &out)
        case let .array(items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                try emit(item, into: &out)
            }
            out += "]"
        case let .object(fields):
            out += "{"
            // JS `Object.keys(o).sort()` — default sort, i.e. by UTF-16 code unit.
            let keys = fields.keys.sorted(by: lessThanByUTF16)
            for (i, key) in keys.enumerated() {
                if i > 0 { out += "," }
                emitString(key, into: &out)
                out += ":"
                try emit(fields[key]!, into: &out)
            }
            out += "}"
        }
    }

    /// Lexicographic comparison over UTF-16 code units — what JS `sort()` does.
    /// Swift's `String <` uses Unicode canonical ordering over grapheme clusters
    /// and would order some non-ASCII keys differently.
    static func lessThanByUTF16(_ a: String, _ b: String) -> Bool {
        var ai = a.utf16.makeIterator()
        var bi = b.utf16.makeIterator()
        while true {
            switch (ai.next(), bi.next()) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (x?, y?):
                if x != y { return x < y }
            }
        }
    }

    /// `JSON.stringify` string escaping: `"` and `\` escaped, the five short
    /// escapes, everything else below U+0020 as `\u00xx` with LOWERCASE hex, and
    /// every other scalar (including U+007F and all non-ASCII) emitted literally
    /// as UTF-8. Notably `/` is NOT escaped.
    static func emitString(_ s: String, into out: inout String) {
        out.append("\"")
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += "\\u" + String(format: "%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out.append("\"")
    }

    /// JS `String(Number(lexeme))` for the subset we allow. See the header for
    /// why anything else throws.
    static func canonicalNumber(_ lexeme: String) throws -> String {
        guard let d = Double(lexeme), d.isFinite else { throw Error.invalidNumber(lexeme) }
        let rounded = d.rounded(.towardZero)
        guard d == rounded, abs(d) < 9_007_199_254_740_992 else {   // 2^53
            throw Error.unsupportedNumber(lexeme)
        }
        // Int64(-0.0) == 0, and JS prints -0 as "0" — the two agree.
        return String(Int64(rounded))
    }

    // MARK: - Parse

    private static let maxDepth = 64

    public static func parse(_ raw: Data) throws -> Value {
        var p = Parser(bytes: [UInt8](raw))
        let v = try p.parseValue(depth: 0)
        p.skipWhitespace()
        guard p.atEnd else { throw Error.trailingGarbage(at: p.i) }
        return v
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        var atEnd: Bool { i >= bytes.count }

        mutating func skipWhitespace() {
            // JSON whitespace: space, tab, LF, CR. Nothing else.
            while i < bytes.count {
                switch bytes[i] {
                case 0x20, 0x09, 0x0A, 0x0D: i += 1
                default: return
                }
            }
        }

        mutating func parseValue(depth: Int) throws -> Value {
            guard depth <= CanonicalJSON.maxDepth else { throw Error.depthExceeded }
            skipWhitespace()
            guard i < bytes.count else { throw Error.unexpectedEnd }
            switch bytes[i] {
            case UInt8(ascii: "{"): return try parseObject(depth: depth)
            case UInt8(ascii: "["): return try parseArray(depth: depth)
            case UInt8(ascii: "\""): return .string(try parseString())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return .number(lexeme: try parseNumberLexeme())
            }
        }

        mutating func expect(_ word: String) throws {
            for ch in word.utf8 {
                guard i < bytes.count else { throw Error.unexpectedEnd }
                guard bytes[i] == ch else { throw Error.unexpectedByte(bytes[i], at: i) }
                i += 1
            }
        }

        mutating func parseObject(depth: Int) throws -> Value {
            i += 1 // '{'
            var out: [String: Value] = [:]
            skipWhitespace()
            if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
            while true {
                skipWhitespace()
                guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else {
                    throw i < bytes.count ? Error.unexpectedByte(bytes[i], at: i) : Error.unexpectedEnd
                }
                let key = try parseString()
                skipWhitespace()
                guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else {
                    throw i < bytes.count ? Error.unexpectedByte(bytes[i], at: i) : Error.unexpectedEnd
                }
                i += 1
                out[key] = try parseValue(depth: depth + 1)   // duplicate key → last wins
                skipWhitespace()
                guard i < bytes.count else { throw Error.unexpectedEnd }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
                throw Error.unexpectedByte(bytes[i], at: i)
            }
        }

        mutating func parseArray(depth: Int) throws -> Value {
            i += 1 // '['
            var out: [Value] = []
            skipWhitespace()
            if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
            while true {
                out.append(try parseValue(depth: depth + 1))
                skipWhitespace()
                guard i < bytes.count else { throw Error.unexpectedEnd }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
                throw Error.unexpectedByte(bytes[i], at: i)
            }
        }

        mutating func parseNumberLexeme() throws -> String {
            let start = i
            if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
            var sawDigit = false
            while i < bytes.count {
                let b = bytes[i]
                if b >= 0x30 && b <= 0x39 { sawDigit = true; i += 1; continue }
                if b == UInt8(ascii: ".") || b == UInt8(ascii: "e") || b == UInt8(ascii: "E")
                    || b == UInt8(ascii: "+") || b == UInt8(ascii: "-") { i += 1; continue }
                break
            }
            guard sawDigit, let s = String(bytes: bytes[start..<i], encoding: .utf8) else {
                throw Error.invalidNumber(String(bytes: bytes[start..<min(i + 1, bytes.count)], encoding: .utf8) ?? "?")
            }
            return s
        }

        mutating func parseString() throws -> String {
            i += 1 // opening quote
            var scalars = String.UnicodeScalarView()
            var literal = [UInt8]()

            func flushLiteral() throws {
                guard !literal.isEmpty else { return }
                guard let s = String(bytes: literal, encoding: .utf8) else { throw Error.invalidUTF8 }
                scalars.append(contentsOf: s.unicodeScalars)
                literal.removeAll(keepingCapacity: true)
            }

            while true {
                guard i < bytes.count else { throw Error.unexpectedEnd }
                let b = bytes[i]
                if b == UInt8(ascii: "\"") {
                    i += 1
                    try flushLiteral()
                    return String(scalars)
                }
                if b == UInt8(ascii: "\\") {
                    try flushLiteral()
                    i += 1
                    guard i < bytes.count else { throw Error.unexpectedEnd }
                    let e = bytes[i]
                    i += 1
                    switch e {
                    case UInt8(ascii: "\""): scalars.append("\"")
                    case UInt8(ascii: "\\"): scalars.append("\\")
                    case UInt8(ascii: "/"):  scalars.append("/")
                    case UInt8(ascii: "b"):  scalars.append("\u{08}")
                    case UInt8(ascii: "f"):  scalars.append("\u{0C}")
                    case UInt8(ascii: "n"):  scalars.append("\u{0A}")
                    case UInt8(ascii: "r"):  scalars.append("\u{0D}")
                    case UInt8(ascii: "t"):  scalars.append("\u{09}")
                    case UInt8(ascii: "u"):
                        let unit = try parseHex4()
                        if unit >= 0xD800 && unit <= 0xDBFF {
                            // High surrogate — a low surrogate MUST follow.
                            guard i + 1 < bytes.count,
                                  bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") else {
                                throw Error.loneSurrogate(at: i)
                            }
                            i += 2
                            let low = try parseHex4()
                            guard low >= 0xDC00 && low <= 0xDFFF else { throw Error.loneSurrogate(at: i) }
                            let cp = 0x10000 + (UInt32(unit - 0xD800) << 10) + UInt32(low - 0xDC00)
                            guard let s = Unicode.Scalar(cp) else { throw Error.loneSurrogate(at: i) }
                            scalars.append(s)
                        } else if unit >= 0xDC00 && unit <= 0xDFFF {
                            throw Error.loneSurrogate(at: i)
                        } else {
                            guard let s = Unicode.Scalar(UInt32(unit)) else { throw Error.loneSurrogate(at: i) }
                            scalars.append(s)
                        }
                    default:
                        throw Error.invalidEscape(at: i - 1)
                    }
                    continue
                }
                if b < 0x20 { throw Error.unexpectedByte(b, at: i) }  // raw control char: invalid JSON
                literal.append(b)
                i += 1
            }
        }

        mutating func parseHex4() throws -> UInt16 {
            guard i + 3 < bytes.count else { throw Error.unexpectedEnd }
            var v: UInt16 = 0
            for _ in 0..<4 {
                let b = bytes[i]
                let d: UInt16
                switch b {
                case 0x30...0x39: d = UInt16(b - 0x30)
                case 0x61...0x66: d = UInt16(b - 0x61 + 10)
                case 0x41...0x46: d = UInt16(b - 0x41 + 10)
                default: throw Error.invalidEscape(at: i)
                }
                v = v << 4 | d
                i += 1
            }
            return v
        }
    }
}
