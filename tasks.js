(() => {
  "use strict";

  const data = window.MEDIKTEST_TASKS;
  const DEFAULT_HEIGHT = 250;
  const OVERSCAN = 900;
  const letters = "ABCDEFGHIJKL".split("");
  const numberFormat = new Intl.NumberFormat("ru-RU");

  const state = {
    sectionId: "all",
    query: "",
    searchAnswers: false,
    resultCaseCount: 0,
    sectionsCollapsed: false,
    filtered: [],
    heights: [],
    offsets: [0],
    totalHeight: 0,
    renderQueued: false,
    heightQueued: false,
    renderedStart: -1,
    renderedEnd: -1,
    renderedKeys: "",
    expandedCases: new Set(),
  };

  const elements = {
    workspace: document.getElementById("workspace"),
    taskTotal: document.getElementById("taskTotal"),
    topicTotal: document.getElementById("topicTotal"),
    allCount: document.getElementById("allCount"),
    sectionsList: document.getElementById("sectionsList"),
    sectionsToggle: document.getElementById("sectionsToggle"),
    mobileSectionSelect: document.getElementById("mobileSectionSelect"),
    searchInput: document.getElementById("searchInput"),
    searchAnswersToggle: document.getElementById("searchAnswersToggle"),
    resultCount: document.getElementById("resultCount"),
    resultLabel: document.getElementById("resultLabel"),
    activeSection: document.getElementById("activeSection"),
    emptyState: document.getElementById("emptyState"),
    viewport: document.getElementById("virtualViewport"),
    canvas: document.getElementById("virtualCanvas"),
  };

  const topicsById = new Map(data.topics.map((topic) => [String(topic.id), topic]));
  const topicCaseSets = new Map(
    data.topics.map((topic) => [String(topic.id), new Set(topic.caseIds)])
  );
  const topicTitleById = new Map(data.topics.map((topic) => [topic.id, topic.title]));

  function displayText(value) {
    return String(value || "")
      .replace(/<sup>(.*?)<\/sup>/gis, "^$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<<<image:([^>]+)>>>/gi, "\n[Изображение: $1]\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalize(value) {
    return String(value || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function wordsFromNormalized(value) {
    return [...new Set(value.split(" ").filter(Boolean))];
  }

  function tokenizeOriginalText(value) {
    const tokens = [];
    for (const match of String(value || "").matchAll(/[\p{L}\p{N}]+/gu)) {
      const normalized = normalize(match[0]);
      if (!normalized) continue;
      tokens.push({
        start: match.index,
        end: match.index + match[0].length,
        normalized,
      });
    }
    return tokens;
  }

  function makeChunk(label, value, kind) {
    const text = displayText(value);
    if (!text) return null;
    const normalized = normalize(text);
    return {
      label,
      kind,
      text,
      normalized,
      words: wordsFromNormalized(normalized),
    };
  }

  for (const clinicalCase of data.cases) {
    clinicalCase._topicNames = clinicalCase.topicIds
      .map((id) => topicTitleById.get(id))
      .filter(Boolean)
      .join(" · ");

    const primaryChunks = [];
    const answerChunks = [];
    const diagnosisChunk = makeChunk("Диагноз", clinicalCase.diagnosis, "diagnosis");
    if (diagnosisChunk) primaryChunks.push(diagnosisChunk);

    clinicalCase.description.forEach((section) => {
      section._display = displayText(section.text);
      const chunk = makeChunk(section.label, section.text, "description");
      if (chunk) primaryChunks.push(chunk);
    });

    clinicalCase.questions.forEach((question, index) => {
      question._display = displayText(question.question);
      question._resultDisplay = displayText(question.result);
      const questionChunk = makeChunk(`Шаг ${index + 1}`, question.question, "question");
      const resultChunk = makeChunk(`Результаты, шаг ${index + 1}`, question.result, "result");
      if (questionChunk) primaryChunks.push(questionChunk);
      if (resultChunk) primaryChunks.push(resultChunk);

      question.incorrectAnswers = question.incorrectAnswers.map((answer) => ({
        text: answer,
        _display: displayText(answer),
        correct: false,
        explanation: "",
        _explanationDisplay: "",
      }));
      question.correctAnswers = question.correctAnswers.map((answer) => ({
        ...answer,
        _display: displayText(answer.text),
        correct: true,
        _explanationDisplay: displayText(answer.explanation),
      }));
      question._answers = [...question.incorrectAnswers, ...question.correctAnswers];

      question._answers.forEach((answer) => {
        const answerChunk = makeChunk(`Ответ, шаг ${index + 1}`, answer.text, "answer");
        const explanationChunk = makeChunk(
          `Пояснение, шаг ${index + 1}`,
          answer.explanation,
          "explanation"
        );
        if (answerChunk) answerChunks.push(answerChunk);
        if (explanationChunk) answerChunks.push(explanationChunk);
      });
    });

    clinicalCase._primaryChunks = primaryChunks;
    clinicalCase._answerChunks = answerChunks;
    clinicalCase._primaryNormalized = normalize(
      [
        `Задача ${clinicalCase.number}`,
        clinicalCase.id,
        clinicalCase._topicNames,
        ...primaryChunks.map((chunk) => chunk.text),
      ].join(" ")
    );
    clinicalCase._allNormalized = normalize(
      [clinicalCase._primaryNormalized, ...answerChunks.map((chunk) => chunk.text)].join(" ")
    );
    clinicalCase._primaryWords = wordsFromNormalized(clinicalCase._primaryNormalized);
    clinicalCase._allWords = wordsFromNormalized(clinicalCase._allNormalized);
  }

  const resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (!Number.isFinite(index)) continue;
      const measured = Math.ceil(entry.contentRect.height) + 16;
      if (Math.abs((state.heights[index] || DEFAULT_HEIGHT) - measured) > 2) {
        state.heights[index] = Math.max(80, measured);
        changed = true;
      }
    }
    if (changed) queueHeightRefresh();
  });

  function searchTextFor(clinicalCase) {
    return state.searchAnswers
      ? clinicalCase._allNormalized
      : clinicalCase._primaryNormalized;
  }

  function searchWordsFor(clinicalCase) {
    return state.searchAnswers ? clinicalCase._allWords : clinicalCase._primaryWords;
  }

  function boundedDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    if (a === b) return 0;

    const previous = new Array(b.length + 1);
    const current = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) previous[j] = j;

    for (let i = 1; i <= a.length; i += 1) {
      current[0] = i;
      let rowBest = current[0];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const value = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + cost
        );
        current[j] = value;
        if (value < rowBest) rowBest = value;
      }
      if (rowBest > limit) return limit + 1;
      for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }
    return previous[b.length];
  }

  function tokenScore(searchText, words, token) {
    if (token.length <= 2) return words.includes(token) ? 0 : Infinity;
    if (searchText.includes(token)) return 0;

    let best = Infinity;
    const limit = token.length <= 4 ? 1 : token.length <= 8 ? 2 : 3;
    for (const word of words) {
      if (word.length < 3 && token.length > 3) continue;
      if (word.startsWith(token) || token.startsWith(word)) {
        best = Math.min(best, 1 + Math.abs(word.length - token.length) / 8);
        continue;
      }
      if (Math.abs(word.length - token.length) > limit) continue;
      const distance = boundedDistance(token, word, limit);
      if (distance <= limit) best = Math.min(best, 2 + distance);
      if (best <= 1) break;
    }
    return best;
  }

  function fuzzyScore(clinicalCase, tokens) {
    const searchText = searchTextFor(clinicalCase);
    const words = searchWordsFor(clinicalCase);
    let score = 0;
    for (const token of tokens) {
      const itemScore = tokenScore(searchText, words, token);
      if (!Number.isFinite(itemScore)) return Infinity;
      score += itemScore;
    }
    return score;
  }

  function phraseScore(clinicalCase, normalizedQuery) {
    if (!normalizedQuery) return 0;
    const index = searchTextFor(clinicalCase).indexOf(normalizedQuery);
    if (index === -1) return Infinity;
    return index === 0 ? 0 : 1 + index / 100000;
  }

  function queryTokenMatchesWord(token, word, matchKind) {
    if (!token || !word) return false;
    if (token.length <= 2) return word === token;
    if (word.length < 3 && token.length > 3) return false;
    if (word.includes(token)) return true;
    if (matchKind !== "words") return false;

    const limit = token.length <= 4 ? 1 : token.length <= 8 ? 2 : 3;
    if (word.startsWith(token) || token.startsWith(word)) return true;
    if (Math.abs(word.length - token.length) > limit) return false;
    return boundedDistance(token, word, limit) <= limit;
  }

  function highlightRanges(text, item) {
    if (!item.highlightTokens?.length) return [];
    const ranges = [];
    for (const word of tokenizeOriginalText(text)) {
      const shouldHighlight = item.highlightTokens.some((token) =>
        queryTokenMatchesWord(token, word.normalized, item.matchKind)
      );
      if (shouldHighlight) ranges.push({ start: word.start, end: word.end });
    }
    return mergeRanges(ranges);
  }

  function mergeRanges(ranges) {
    if (ranges.length < 2) return ranges;
    const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [sorted[0]];
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index];
      const previous = merged[merged.length - 1];
      if (current.start <= previous.end) previous.end = Math.max(previous.end, current.end);
      else merged.push(current);
    }
    return merged;
  }

  function appendHighlightedText(node, text, item) {
    const ranges = highlightRanges(text, item);
    if (!ranges.length) {
      node.textContent = text;
      return;
    }

    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        node.appendChild(document.createTextNode(text.slice(cursor, range.start)));
      }
      const mark = document.createElement("mark");
      mark.textContent = text.slice(range.start, range.end);
      node.appendChild(mark);
      cursor = range.end;
    }
    if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function renderSections() {
    const fragment = document.createDocumentFragment();
    for (const topic of data.topics) {
      const button = document.createElement("button");
      button.className = "section-item";
      button.type = "button";
      button.dataset.section = String(topic.id);

      const title = document.createElement("span");
      title.className = "section-title";
      title.textContent = topic.title;

      const count = document.createElement("span");
      count.className = "section-count";
      count.textContent = numberFormat.format(topic.count);
      button.append(title, count);
      fragment.appendChild(button);

      const option = document.createElement("option");
      option.value = String(topic.id);
      option.textContent = `${topic.title} (${numberFormat.format(topic.count)})`;
      elements.mobileSectionSelect.appendChild(option);
    }
    elements.sectionsList.replaceChildren(fragment);
  }

  function setActiveSection(sectionId) {
    state.sectionId = sectionId;
    document.querySelectorAll(".section-item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.section === sectionId);
    });
    elements.mobileSectionSelect.value = sectionId;
    applyFilters(true);
  }

  function setSectionsCollapsed(collapsed) {
    state.sectionsCollapsed = collapsed;
    elements.workspace.classList.toggle("sections-collapsed", collapsed);
    elements.sectionsToggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Развернуть список тем" : "Свернуть список тем";
    elements.sectionsToggle.setAttribute("aria-label", label);
    elements.sectionsToggle.title = label;
    queueRender();
  }

  function currentSectionTitle() {
    if (state.sectionId === "all") return "Все задачи";
    return topicsById.get(state.sectionId)?.title || "Все задачи";
  }

  function applyFilters(resetScroll = false) {
    const normalizedQuery = normalize(state.query);
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    const caseSet = state.sectionId === "all" ? null : topicCaseSets.get(state.sectionId);
    const phraseMatches = [];
    const wordMatches = [];
    const phraseIds = new Set();

    for (const clinicalCase of data.cases) {
      if (caseSet && !caseSet.has(clinicalCase.id)) continue;
      const score = tokens.length ? phraseScore(clinicalCase, normalizedQuery) : 0;
      if (!Number.isFinite(score)) continue;
      phraseIds.add(clinicalCase.id);
      phraseMatches.push({
        type: "case",
        clinicalCase,
        score,
        matchKind: "phrase",
        highlightTokens: tokens,
        searchAnswers: state.searchAnswers,
        normalizedQuery,
      });
    }

    if (tokens.length) {
      for (const clinicalCase of data.cases) {
        if (phraseIds.has(clinicalCase.id)) continue;
        if (caseSet && !caseSet.has(clinicalCase.id)) continue;
        const score = fuzzyScore(clinicalCase, tokens);
        if (!Number.isFinite(score)) continue;
        wordMatches.push({
          type: "case",
          clinicalCase,
          score,
          matchKind: "words",
          highlightTokens: tokens,
          searchAnswers: state.searchAnswers,
          normalizedQuery,
        });
      }
    }

    phraseMatches.sort((a, b) => a.score - b.score || a.clinicalCase.number - b.clinicalCase.number);
    wordMatches.sort((a, b) => a.score - b.score || a.clinicalCase.number - b.clinicalCase.number);

    const filtered = [...phraseMatches];
    if (tokens.length && wordMatches.length) {
      if (phraseMatches.length) filtered.push({ type: "separator", id: "words-any-order" });
      filtered.push(...wordMatches);
    }

    state.filtered = filtered;
    state.resultCaseCount = phraseMatches.length + wordMatches.length;
    state.heights = new Array(filtered.length).fill(DEFAULT_HEIGHT);
    resetRenderedRows();
    rebuildOffsets();

    elements.resultCount.textContent = numberFormat.format(state.resultCaseCount);
    elements.resultLabel.textContent = resultLabel(state.resultCaseCount);
    elements.activeSection.textContent = currentSectionTitle();
    elements.emptyState.hidden = state.resultCaseCount !== 0;
    elements.viewport.hidden = state.resultCaseCount === 0;
    if (resetScroll) elements.viewport.scrollTop = 0;
    queueRender();
  }

  function resultLabel(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "задача найдена";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return "задачи найдено";
    }
    return "задач найдено";
  }

  function rebuildOffsets() {
    state.offsets = new Array(state.filtered.length + 1);
    state.offsets[0] = 0;
    for (let index = 0; index < state.filtered.length; index += 1) {
      state.offsets[index + 1] = state.offsets[index] + (state.heights[index] || DEFAULT_HEIGHT);
    }
    state.totalHeight = state.offsets[state.offsets.length - 1] || 0;
    elements.canvas.style.height = `${state.totalHeight}px`;
  }

  function lowerBound(array, value) {
    let low = 0;
    let high = array.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (array[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function visibleRange() {
    const top = Math.max(0, elements.viewport.scrollTop - OVERSCAN);
    const bottom = elements.viewport.scrollTop + elements.viewport.clientHeight + OVERSCAN;
    const start = Math.max(0, lowerBound(state.offsets, top) - 1);
    let end = lowerBound(state.offsets, bottom) + 1;
    end = Math.min(state.filtered.length, Math.max(end, start + 1));
    return { start, end };
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderVirtualRows();
    });
  }

  function queueHeightRefresh() {
    if (state.heightQueued) return;
    state.heightQueued = true;
    requestAnimationFrame(() => {
      state.heightQueued = false;
      rebuildOffsets();
      queueRender();
    });
  }

  function resetRenderedRows() {
    state.renderedStart = -1;
    state.renderedEnd = -1;
    state.renderedKeys = "";
  }

  function itemKeyFor(item) {
    if (item.type === "separator") return `separator:${item.id}`;
    const expanded = state.expandedCases.has(item.clinicalCase.id) ? "open" : "closed";
    return `case:${item.clinicalCase.id}:${item.matchKind}:${expanded}`;
  }

  function renderedKeysFor(start, end) {
    const keys = [];
    for (let index = start; index < end; index += 1) keys.push(itemKeyFor(state.filtered[index]));
    return keys.join("|");
  }

  function updateRenderedRowPositions() {
    for (const row of elements.canvas.children) {
      const index = Number(row.dataset.index);
      if (Number.isFinite(index)) row.style.transform = `translateY(${state.offsets[index]}px)`;
    }
  }

  function renderVirtualRows() {
    const { start, end } = visibleRange();
    const keys = renderedKeysFor(start, end);
    if (
      state.renderedStart === start &&
      state.renderedEnd === end &&
      state.renderedKeys === keys &&
      elements.canvas.children.length === end - start
    ) {
      updateRenderedRowPositions();
      return;
    }

    resizeObserver.disconnect();
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const item = state.filtered[index];
      const row = document.createElement("div");
      row.className = "virtual-row";
      row.dataset.index = String(index);
      row.style.transform = `translateY(${state.offsets[index]}px)`;
      row.appendChild(item.type === "separator" ? renderResultSeparator() : renderCaseCard(item));
      fragment.appendChild(row);
      resizeObserver.observe(row);
    }
    elements.canvas.replaceChildren(fragment);
    state.renderedStart = start;
    state.renderedEnd = end;
    state.renderedKeys = keys;
  }

  function renderResultSeparator() {
    const separator = document.createElement("div");
    separator.className = "result-separator";
    return separator;
  }

  function matchingChunks(item) {
    if (!item.highlightTokens.length) return [];
    const chunks = item.searchAnswers
      ? [...item.clinicalCase._primaryChunks, ...item.clinicalCase._answerChunks]
      : item.clinicalCase._primaryChunks;
    const result = [];
    for (const chunk of chunks) {
      const phraseMatch = item.normalizedQuery && chunk.normalized.includes(item.normalizedQuery);
      const wordMatch = item.highlightTokens.every((token) =>
        Number.isFinite(tokenScore(chunk.normalized, chunk.words, token))
      );
      if (!phraseMatch && !wordMatch) continue;
      if (result.some((entry) => entry.text === chunk.text)) continue;
      result.push(chunk);
      if (result.length === 3) break;
    }
    if (!result.length) {
      for (const token of item.highlightTokens) {
        const chunk = chunks.find((entry) =>
          Number.isFinite(tokenScore(entry.normalized, entry.words, token))
        );
        if (!chunk || result.includes(chunk)) continue;
        result.push(chunk);
        if (result.length === 3) break;
      }
    }
    return result;
  }

  function renderCaseCard(item) {
    const { clinicalCase } = item;
    const expanded = state.expandedCases.has(clinicalCase.id);
    const article = document.createElement("article");
    article.className = `case-card${expanded ? " is-expanded" : ""}`;
    article.dataset.caseId = clinicalCase.id;

    const header = document.createElement("div");
    header.className = "case-card-header";
    const heading = document.createElement("div");
    heading.className = "case-heading";

    const meta = document.createElement("div");
    meta.className = "case-meta";
    const number = document.createElement("span");
    number.className = "case-number";
    number.textContent = `Задача № ${clinicalCase.number}`;
    const topic = document.createElement("span");
    topic.className = "case-topic";
    topic.textContent = clinicalCase._topicNames;
    meta.append(number, topic);

    const diagnosis = document.createElement("h2");
    diagnosis.className = `case-diagnosis${clinicalCase.diagnosis ? "" : " is-missing"}`;
    appendHighlightedText(diagnosis, clinicalCase.diagnosis || "Диагноз не указан", item);
    heading.append(meta, diagnosis);

    const previewSection = clinicalCase.description[0];
    if (previewSection && !expanded) {
      const preview = document.createElement("p");
      preview.className = "case-preview";
      appendHighlightedText(preview, previewSection._display, item);
      heading.appendChild(preview);
    }

    const toggle = document.createElement("button");
    toggle.className = "case-toggle";
    toggle.type = "button";
    toggle.dataset.action = "toggle-case";
    toggle.dataset.caseId = clinicalCase.id;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.innerHTML = `<span>${expanded ? "Свернуть" : "Открыть 12 шагов"}</span><svg class="case-toggle-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>`;
    header.append(heading, toggle);
    article.appendChild(header);

    const matches = matchingChunks(item);
    if (matches.length && !expanded) article.appendChild(renderMatchList(matches, item));
    if (expanded) article.appendChild(renderCaseContent(clinicalCase, item));
    return article;
  }

  function renderMatchList(matches, item) {
    const list = document.createElement("div");
    list.className = "case-match-list";
    for (const match of matches) {
      const row = document.createElement("div");
      row.className = "case-match";
      const label = document.createElement("span");
      label.className = "case-match-label";
      label.textContent = match.label;
      const text = document.createElement("span");
      text.className = "case-match-text";
      appendHighlightedText(text, match.text, item);
      row.append(label, text);
      list.appendChild(row);
    }
    return list;
  }

  function renderCaseContent(clinicalCase, item) {
    const content = document.createElement("div");
    content.className = "case-content";

    const description = document.createElement("div");
    description.className = "case-description";
    clinicalCase.description.forEach((section) => {
      const row = document.createElement("section");
      row.className = "case-section";
      const title = document.createElement("h3");
      title.className = "case-section-title";
      title.textContent = section.label;
      const text = document.createElement("p");
      text.className = "case-section-text";
      appendHighlightedText(text, section._display, item);
      row.append(title, text);
      description.appendChild(row);
    });
    content.appendChild(description);

    const heading = document.createElement("h3");
    heading.className = "case-questions-heading";
    heading.textContent = "Вопросы и ответы";
    content.appendChild(heading);

    const steps = document.createElement("div");
    steps.className = "case-steps";
    clinicalCase.questions.forEach((question, index) => {
      steps.appendChild(renderCaseStep(question, index, item));
    });
    content.appendChild(steps);
    return content;
  }

  function renderCaseStep(question, index, item) {
    const section = document.createElement("section");
    section.className = "case-step";
    const header = document.createElement("div");
    header.className = "case-step-header";
    const number = document.createElement("span");
    number.className = "case-step-number";
    number.textContent = String(index + 1);
    const prompt = document.createElement("p");
    prompt.className = "case-step-question";
    appendHighlightedText(prompt, question._display, item);
    header.append(number, prompt);
    section.appendChild(header);

    const answers = document.createElement("div");
    answers.className = "case-answers";
    question._answers.forEach((answer, answerIndex) => {
      const row = document.createElement("div");
      row.className = `case-answer${answer.correct ? " is-correct" : ""}`;
      const letter = document.createElement("span");
      letter.className = "case-answer-letter";
      letter.textContent = letters[answerIndex] || String(answerIndex + 1);
      const body = document.createElement("div");
      body.className = "case-answer-body";
      const text = document.createElement("div");
      appendHighlightedText(text, answer._display, item);
      body.appendChild(text);
      if (answer.correct && answer._explanationDisplay) {
        const explanation = document.createElement("p");
        explanation.className = "case-answer-explanation";
        appendHighlightedText(explanation, answer._explanationDisplay, item);
        body.appendChild(explanation);
      }
      row.append(letter, body);
      answers.appendChild(row);
    });
    section.appendChild(answers);

    if (question._resultDisplay) {
      const result = document.createElement("div");
      result.className = "case-result";
      const title = document.createElement("span");
      title.className = "case-result-title";
      title.textContent = "Результаты после ответа";
      const text = document.createElement("p");
      text.className = "case-result-text";
      appendHighlightedText(text, question._resultDisplay, item);
      result.append(title, text);
      section.appendChild(result);
    }
    return section;
  }

  function toggleCase(caseId) {
    if (state.expandedCases.has(caseId)) state.expandedCases.delete(caseId);
    else state.expandedCases.add(caseId);
    const index = state.filtered.findIndex(
      (item) => item.type === "case" && item.clinicalCase.id === caseId
    );
    if (index >= 0) state.heights[index] = DEFAULT_HEIGHT;
    resetRenderedRows();
    rebuildOffsets();
    queueRender();
  }

  function debounce(callback, delay) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
  }

  function updateSearchPlaceholder() {
    elements.searchInput.placeholder = state.searchAnswers
      ? "Поиск по условиям, вопросам, ответам и пояснениям"
      : "Поиск по условиям и вопросам";
  }

  function init() {
    elements.taskTotal.textContent = `${numberFormat.format(data.stats.caseCount)} задач`;
    elements.topicTotal.textContent = `${numberFormat.format(data.stats.topicCount)} тем`;
    elements.allCount.textContent = numberFormat.format(data.stats.caseCount);
    renderSections();

    elements.sectionsList.addEventListener("click", (event) => {
      const button = event.target.closest(".section-item");
      if (button) setActiveSection(button.dataset.section);
    });
    document.querySelector('[data-section="all"]').addEventListener("click", () => {
      setActiveSection("all");
    });
    elements.mobileSectionSelect.addEventListener("change", () => {
      setActiveSection(elements.mobileSectionSelect.value);
    });
    elements.sectionsToggle.addEventListener("click", () => {
      setSectionsCollapsed(!state.sectionsCollapsed);
    });
    elements.searchInput.addEventListener(
      "input",
      debounce(() => {
        state.query = elements.searchInput.value;
        applyFilters(true);
      }, 120)
    );
    elements.searchAnswersToggle.addEventListener("change", () => {
      state.searchAnswers = elements.searchAnswersToggle.checked;
      updateSearchPlaceholder();
      applyFilters(true);
    });
    elements.canvas.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="toggle-case"]');
      if (button) toggleCase(button.dataset.caseId);
    });
    elements.viewport.addEventListener("scroll", queueRender, { passive: true });
    window.addEventListener("resize", () => {
      rebuildOffsets();
      queueRender();
    });

    updateSearchPlaceholder();
    applyFilters();
  }

  init();
})();
