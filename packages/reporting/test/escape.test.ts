import { describe, expect, it } from "vitest"
import { artifactHref, embedJson, escapeHtml, escapeXml, stripInvalidXmlChars } from "../src/escape.js"

describe("escapeHtml", () => {
  it("neutralises every character that can leave text position", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;"
    )
  })

  it("escapes the ampersand first so entities cannot be reconstructed", () => {
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;")
  })
})

describe("escapeXml", () => {
  it("escapes markup and quotes", () => {
    expect(escapeXml(`</failure><failure message="x">`)).toBe(
      "&lt;/failure&gt;&lt;failure message=&quot;x&quot;&gt;"
    )
  })

  it("replaces code points XML 1.0 forbids outright", () => {
    expect(stripInvalidXmlChars("a\u0000b\u0008c")).toBe("a\uFFFDb\uFFFDc")
    expect(stripInvalidXmlChars("tab\tnewline\n")).toBe("tab\tnewline\n")
  })
})

describe("embedJson", () => {
  it("cannot close the script element it sits in", () => {
    const payload = embedJson({ text: "</script><script>alert(1)</script>" })
    expect(payload).not.toContain("</script")
    expect(payload).not.toContain("<")
    expect(JSON.parse(payload)).toEqual({ text: "</script><script>alert(1)</script>" })
  })

  it("escapes the line separators that break inline scripts", () => {
    expect(embedJson("a\u2028b\u2029c")).toBe('"a\\u2028b\\u2029c"')
  })
})

describe("artifactHref", () => {
  it("accepts a relative path inside the run directory", () => {
    expect(artifactHref("attempts/a1/screenshots/x y.png")).toBe("attempts/a1/screenshots/x%20y.png")
  })

  it("refuses anything that is not a contained relative path", () => {
    expect(artifactHref("javascript:alert(1)")).toBeUndefined()
    expect(artifactHref("/etc/passwd")).toBeUndefined()
    expect(artifactHref("//evil.example/x")).toBeUndefined()
    expect(artifactHref("../../secrets.json")).toBeUndefined()
    expect(artifactHref("  ")).toBeUndefined()
  })
})
