import { FakeLLMProvider } from "@dentalos/adapters";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language";
import { understand, understandByRules, type ProcedureOption } from "./intents";

const PROCS: ProcedureOption[] = [
  {
    id: "p-rct",
    code: "rct_sitting",
    names: ["Root canal (RCT) sitting", "rct", "root canal", "nas ka ilaaj"],
  },
  { id: "p-scaling", code: "scaling", names: ["Scaling and polishing", "cleaning", "safai", "daant saaf"] },
  { id: "p-consult", code: "consultation", names: ["Consultation", "checkup", "check up"] },
  { id: "p-braces", code: "ortho_adjustment", names: ["Braces adjustment", "braces tight"] },
];
const TODAY = "2026-10-13";
const rules = (t: string) => understandByRules(t, TODAY, PROCS);

describe("intent rules", () => {
  it.each([
    ["STOP", "stop"],
    ["band karo", "stop"],
    ["Start", "start"],
    ["kya aap robot ho?", "bot_question"],
    ["are you a real person", "bot_question"],
    ["mujhe kisi se baat karni hai", "human"],
    ["please call me", "human"],
    ["appointment cancel karna hai", "cancel"],
    ["kal nahi aa paunga", "cancel"],
    ["time change karna hai", "reschedule"],
    ["mera appointment kab hai?", "check_appointment"],
    ["RCT kitna ka hai?", "price"],
    ["Sunday ko khula hai kya?", "timings"],
    ["clinic kahan hai", "location"],
    ["parking hai?", "location"],
    ["doctor sahab aaj hain kya", "doctors"],
    ["kal shaam appointment chahiye", "book"],
    ["daant saaf karwana hai", "book"],
    ["नमस्ते", "greeting"],
    ["thank you", "thanks"],
    ["haan", "yes"],
    ["नहीं", "no"],
  ])("%j → %s", (text, intent) => expect(rules(text).intent).toBe(intent));

  it("extracts treatment, day, part of day and relation", () => {
    const u = rules("mere papa ke liye kal shaam RCT ka appointment chahiye");
    expect(u).toMatchObject({
      intent: "book",
      procedureId: "p-rct",
      partsOfDay: ["evening"],
      relationship: "father",
    });
    expect(u.date?.fromDate).toBe("2026-10-14");
  });

  it("a treatment or date alone implies booking", () => {
    expect(rules("safai kal").intent).toBe("book");
  });

  it("understands Hindi-script speech transcripts", () => {
    const u = rules("मुझे कल शाम को अपॉइंटमेंट चाहिए");
    expect(u.intent).toBe("book");
    expect(u.date?.fromDate).toBe("2026-10-14");
    expect(u.partsOfDay).toEqual(["evening"]);
    expect(rules("समय बदलना है").intent).toBe("reschedule");
    expect(rules("दूसरा वाला").choice).toBe(2);
    expect(rules("हाँ जी").intent).toBe("yes");
    expect(rules("kal 2 baje").choice).toBeNull();
    expect(rules("2").choice).toBe(2);
    expect(rules("pehle wala theek hai").choice).toBe(1);
  });

  it("finds treatments named in Hindi script", () => {
    expect(rules("सफ़ाई करानी है").procedureId).toBe(rules("safai karani hai").procedureId);
    expect(rules("सफ़ाई करानी है").procedureId).not.toBeNull();
  });

  it("medicine questions are recognised (and never answered)", () => {
    expect(rules("dard ke liye kaunsi dawai lu").intent).toBe("medical");
    expect(rules("which painkiller should I take").intent).toBe("medical");
    expect(rules("दर्द के लिए कौन सी दवा लूं").intent).toBe("medical");
  });

  it("numbered choices", () => {
    expect(rules("2").choice).toBe(2);
    expect(rules("doosra").choice).toBe(2);
  });
});

describe("language", () => {
  it.each([
    ["RCT kitna ka hai?", "hinglish"],
    ["What are your timings?", "en"],
    ["कल शाम को आ सकते हैं?", "hi"],
    ["kal aana hai", "hinglish"],
  ])("%j → %s", (t, lang) => expect(detectLanguage(t)).toBe(lang));
});

describe("model fallback", () => {
  it("asks the model only when rules are unsure, and maps its answer through the same matchers", async () => {
    const llm = new FakeLLMProvider();
    llm.extractions.set("whatsapp_nlu", () => ({
      intent: "book",
      treatment_words: "nas ka ilaaj",
      when_words: "agle mangalvaar",
      part_of_day: null,
      for_relationship: null,
    }));
    const u = await understand("wo jo nas ka ilaaj hota hai uske liye agle mangalvaar", {
      today: TODAY,
      procedures: PROCS,
      llm,
    });
    expect(u).toMatchObject({ source: "rules", intent: "book", procedureId: "p-rct" });
    const v = await understand("mera wala dant bahut hil raha hai dekh lo", {
      today: TODAY,
      procedures: PROCS,
      llm,
    });
    expect(v.source).toBe("llm");
    expect(llm.extractRequests).toHaveLength(1);
  });

  it("keeps working when the model is down", async () => {
    const llm = new FakeLLMProvider();
    llm.support.failNext("503", true);
    const u = await understand("ek sawaal tha aapse please", { today: TODAY, procedures: PROCS, llm });
    expect(u).toMatchObject({ intent: "other", source: "rules" });
  });
});
