import { describe, expect, it } from "vitest";
import { authorizeUrl, percentEncode, sign, signatureBaseString } from "../src/zotero/oauth1";

describe("OAuth 1.0a signing", () => {
  // RFC 5849 §1.2 worked example (the RFC prints the expected signature).
  const params = {
    oauth_consumer_key: "dpf43f3p2l4k3l03",
    oauth_token: "nnch734d00sl2jdk",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1191242096",
    oauth_nonce: "kllo9940pd9333jh",
    oauth_version: "1.0",
  };
  const url = "http://photos.example.net/photos?file=vacation.jpg&size=original";

  it("builds the RFC 5849 base string, including query parameters", () => {
    expect(signatureBaseString("GET", url, params)).toBe(
      "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal",
    );
  });

  it("produces the RFC 5849 HMAC-SHA1 signature", async () => {
    expect(await sign("GET", url, params, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00")).toBe("tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });

  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("a b!*'()~-._")).toBe("a%20b%21%2A%27%28%29~-._");
    expect(percentEncode("https://x.test/cb?a=1")).toBe("https%3A%2F%2Fx.test%2Fcb%3Fa%3D1");
  });

  it("requests read-only permissions on Zotero's authorize page", () => {
    const u = new URL(
      authorizeUrl("rt1", { name: "Reader for Zotero (Claude)", libraryAccess: true, notesAccess: true, writeAccess: false, allGroups: "read" }),
    );
    expect(u.origin + u.pathname).toBe("https://www.zotero.org/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      oauth_token: "rt1",
      name: "Reader for Zotero (Claude)",
      library_access: "1",
      notes_access: "1",
      write_access: "0",
      all_groups: "read",
    });
  });
});
