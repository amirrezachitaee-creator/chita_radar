const STRONG_PATTERNS = [
  [/\bai\b/gi, 'ai'],
  [/\ba\.i\./gi, 'a.i.'],
  [/\bopenai\b/gi, 'openai'],
  [/\banthropic\b/gi, 'anthropic'],
  [/\bclaude\b/gi, 'claude'],
  [/\bchatgpt\b/gi, 'chatgpt'],
  [/\bgpt(?:-?[0-9a-z.]+)?\b/gi, 'gpt'],
  [/\bgemini\b/gi, 'gemini'],
  [/\bdeepmind\b/gi, 'deepmind'],
  [/\bllms?\b/gi, 'llm'],
  [/\bmachine learning\b/gi, 'machine learning'],
  [/\bdeep learning\b/gi, 'deep learning'],
  [/\bneural\b/gi, 'neural'],
  [/\bchatbots?\b/gi, 'chatbot'],
  [/\bcopilot\b/gi, 'copilot'],
  [/\bgenerative\b/gi, 'generative'],
  [/\btransformer\b/gi, 'transformer'],
  [/\bdiffusion\b/gi, 'diffusion'],
  [/\bfoundation models?\b/gi, 'foundation model'],
  [/\bagi\b/gi, 'agi'],
  [/\bmultimodal\b/gi, 'multimodal'],
  [/\bhugging face\b/gi, 'hugging face'],
  [/\bmistral\b/gi, 'mistral'],
  [/\bdeepseek\b/gi, 'deepseek'],
  [/\bqwen\b/gi, 'qwen'],
  [/\bllama\b/gi, 'llama'],
  [/\bgrok\b/gi, 'grok'],
  [/\bxai\b/gi, 'xai'],
  [/\bperplexity\b/gi, 'perplexity'],
  [/\bmidjourney\b/gi, 'midjourney'],
  [/\bsora\b/gi, 'sora'],
  [/\bveo\b/gi, 'veo'],
  [/\bnvidia\b/gi, 'nvidia'],
  [/هوش[\s\u200c]+مصنوعی/gu, 'هوش مصنوعی'],
  [/یادگیری[\s\u200c]+ماشین/gu, 'یادگیری ماشین'],
  [/یادگیری[\s\u200c]+عمیق/gu, 'یادگیری عمیق'],
  [/شبکه[\s\u200c]+عصبی/gu, 'شبکه عصبی'],
  [/مدل[\s\u200c]+زبانی/gu, 'مدل زبانی'],
  [/مدل[\s\u200c]+هوش[\s\u200c]+مصنوعی/gu, 'مدل هوش مصنوعی'],
  [/چت[\s\u200c]*بات/gu, 'چت‌بات'],
  [/عامل(?:[\s\u200c]+های)?[\s\u200c]+هوشمند/gu, 'عامل هوشمند'],
  [/اوپن[\s\u200c]*ای[\s\u200c]*آی/gu, 'اوپن‌ای‌آی'],
  [/آنتروپیک/gu, 'آنتروپیک'],
  [/جمینای/gu, 'جمینای'],
  [/کلود/gu, 'کلود'],
  [/انویدیا/gu, 'انویدیا'],
  [/دیپ[\s\u200c]*سیک/gu, 'دیپ‌سیک'],
];

const WEAK_PATTERNS = [
  [/\bmodels?\b/gi, 'model'],
  [/\bagents?\b/gi, 'agent'],
  [/\bagentic\b/gi, 'agentic'],
  [/\binference\b/gi, 'inference'],
  [/\bgpus?\b/gi, 'gpu'],
  [/\bdata centers?\b/gi, 'data center'],
  [/\bsemiconductors?\b/gi, 'semiconductor'],
  [/\bchips?\b/gi, 'chip'],
  [/\brobots?\b/gi, 'robot'],
  [/\brobotics\b/gi, 'robotics'],
  [/مدل(?:‌ها)?/gu, 'مدل'],
  [/تراشه(?:‌ها)?/gu, 'تراشه'],
  [/چیپ(?:‌ها)?/gu, 'چیپ'],
  [/پردازنده[\s\u200c]+گرافیکی/gu, 'پردازنده گرافیکی'],
  [/دیتا[\s\u200c]*سنتر/gu, 'دیتاسنتر'],
  [/مرکز(?:[\s\u200c]+داده|[\s\u200c]+های[\s\u200c]+داده)/gu, 'مرکز داده'],
  [/ربات(?:‌ها)?/gu, 'ربات'],
  [/استنتاج/gu, 'استنتاج'],
];

function labelsIn(text, patterns) {
  const labels = new Set();
  const value = String(text ?? '');
  for (const [pattern, label] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) labels.add(label);
  }
  return labels;
}

export function aiTerms(text) {
  return new Set([...labelsIn(text, STRONG_PATTERNS), ...labelsIn(text, WEAK_PATTERNS)]);
}

export function aiHint(text) {
  return aiTerms(text).size > 0;
}

export function isAiCentral(title, summary) {
  if (labelsIn(title, STRONG_PATTERNS).size > 0) return true;
  const text = `${title ?? ''} ${summary ?? ''}`;
  const terms = aiTerms(text);
  return terms.size >= 2;
}

export function hasAiMention(text) {
  if (labelsIn(text, STRONG_PATTERNS).size > 0) return true;
  return labelsIn(text, WEAK_PATTERNS).size >= 2;
}
