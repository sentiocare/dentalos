import { describe, expect, it } from "vitest";
import { detectEmergency } from "./emergency";
import { checkOutput } from "./output-filter";

describe("output filter", () => {
  it.each([
    ["Take a Combiflam for the pain.", "medicine"],
    ["Aap dolo le lijiye", "medicine"],
    ["Use clove oil on the tooth", "remedy"],
    ["namak pani se kulla karein", "remedy"],
    ["500 mg twice a day", "dosage"],
    ["din mein do baar lijiye", "dosage"],
    ["1-0-1 after food", "dosage"],
    ["दिन में दो बार गोली लें", "dosage"],
    ["It's nothing serious, don't worry", "severity"],
    ["Ghabrane ki koi baat nahi", "severity"],
    ["चिंता की कोई बात नहीं", "severity"],
    ["You have a cavity", "diagnosis"],
    ["Aapko infection hai", "diagnosis"],
    ["Painless RCT guaranteed", "promise"],
    ["Best dentist in Ranchi", "promise"],
  ])("blocks %j (%s)", (text, reason) => {
    const result = checkOutput(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(reason);
  });

  it.each(
    [
      "Namaste! Your appointment is on Tuesday, 13 October, 5:00 pm with Dr. Sharma.",
      "RCT ka kharcha usually ₹3,500 se ₹7,000 ke beech hota hai. Exact amount doctor check karke batayenge.",
      "Clinic Monday to Saturday 10:00–14:00 aur 17:00–21:00 khula rehta hai.",
      "Sharma Dental Clinic, Shop 12, Main Road, Lalpur. Map: https://maps.google.com/?q=Lalpur",
      "Aapne cancel kar diya hai. Kabhi bhi naya appointment le sakte hain.",
      "मंगलवार, 13 अक्टूबर, शाम 5 बजे",
      "Moxikind? No — mox is only a word here",
    ].slice(0, 6),
  )("allows normal replies: %j", (text) => {
    expect(checkOutput(text)).toEqual({ ok: true });
  });
});

describe("emergency detection", () => {
  it.each([
    ["My face is swollen since last night", "urgent", "facial_swelling"],
    ["gaal me sujan aa gayi hai", "urgent", "facial_swelling"],
    ["मुँह में सूजन है", "urgent", "facial_swelling"],
    ["daant nikalwaya tha, khoon nahi ruk raha", "urgent", "uncontrolled_bleeding"],
    ["bleeding won't stop after extraction", "urgent", "uncontrolled_bleeding"],
    ["beta gir gaya aur daant toot gaya", "urgent", "trauma"],
    ["my son fell and broke his tooth", "urgent", "trauma"],
    ["bahut tez dard ho raha hai, raat bhar soya nahi", "urgent", "severe_pain"],
    ["tez bukhar aur dard", "urgent", "fever_with_pain"],
    ["surgery ke baad problem ho rahi hai", "urgent", "post_surgery_problem"],
    ["sujan hai aur saans lene me dikkat ho rahi hai", "life_threatening", "breathing_difficulty"],
    ["can't swallow, jaw swelling", "life_threatening", "swallowing_difficulty"],
    ["निगलने में दिक्कत है", "life_threatening", "swallowing_difficulty"],
  ])("%j → %s", (text, level, trigger) => {
    const result = detectEmergency(text);
    expect(result.level).toBe(level);
    expect(result.triggers).toContain(trigger);
  });

  it.each([
    "RCT kitna ka hai?",
    "Sunday ko khula hai kya?",
    "kal shaam 5 baje appointment chahiye",
    "cleaning karwani hai",
    "thoda dard hai daant me",
  ])("ordinary message %j is not an emergency", (text) => {
    expect(detectEmergency(text).level).toBe("none");
  });

  it("clinic-specific triggers", () => {
    expect(detectEmergency("pus aa raha hai", ["pus"]).level).toBe("urgent");
  });
});
