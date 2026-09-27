import { describe, expect, it } from "vitest";
import { romanize } from "./romanize";

describe("romanize", () => {
  it.each([
    ["मुझे कल शाम को अपॉइंटमेंट चाहिए", "mujhe kal shaam ko appointment chahiye"],
    ["मंगलवार को आ सकता हूँ", "mangalvaar ko aa sakta hoon"],
    ["दाँत में बहुत दर्द है", "daant mein bahut dard hai"],
    ["समय बदलना है", "samay badalna hai"],
    ["पाँच बजे", "5 baje"],
    ["दूसरा वाला", "doosra wala"],
    ["मेरा नाम रमेश कुमार है", "mera naam ramesh kumaar hai"],
    ["गाल में सूजन है और सांस लेने में दिक्कत", "gaal mein sujan hai aur saans lene mein dikkat"],
    ["१० बजे", "10 baje"],
  ])("%s → %s", (input, expected) => {
    expect(romanize(input)).toBe(expected);
  });

  it("leaves Roman text alone", () => {
    expect(romanize("kal 5 baje")).toBe("kal 5 baje");
  });
});
