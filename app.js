(() => {
  "use strict";

  const data = window.MEDIKTEST_DATA;
  const DEFAULT_HEIGHT = 260;
  const OVERSCAN = 900;
  const letters = ["A", "B", "C", "D", "E", "F"];
  const numberFormat = new Intl.NumberFormat("ru-RU");

  const state = {
    sectionId: "all",
    query: "",
    searchAnswers: false,
    resultQuestionCount: 0,
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
  };

  const elements = {
    workspace: document.getElementById("workspace"),
    questionTotal: document.getElementById("questionTotal"),
    sectionTotal: document.getElementById("sectionTotal"),
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

  const sectionsById = new Map(data.sections.map((section) => [String(section.id), section]));
  const sectionQuestionSets = new Map(
    data.sections.map((section) => [String(section.id), new Set(section.questionIds)])
  );
  const sectionTitleById = new Map(data.sections.map((section) => [section.id, section.title]));

  for (const question of data.questions) {
    const questionText = [question.number, question.question].join(" ");
    const answerText = question.answers.map((answer) => answer.text).join(" ");
    for (const answer of question.answers) {
      answer._tokens = tokenizeOriginalText(answer.text);
    }
    question._questionNormalized = normalize(questionText);
    question._allNormalized = normalize([questionText, answerText].join(" "));
    question._questionWords = wordsFromNormalized(question._questionNormalized);
    question._allWords = wordsFromNormalized(question._allNormalized);
    question._questionTokens = tokenizeOriginalText(question.question);
    question._sectionNames = question.sectionIds
      .slice(0, 2)
      .map((id) => sectionTitleById.get(id))
      .filter(Boolean)
      .join(" · ");
  }

  const resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (!Number.isFinite(index)) continue;
      const measured = Math.ceil(entry.contentRect.height) + 16;
      if (Math.abs((state.heights[index] || DEFAULT_HEIGHT) - measured) > 2) {
        state.heights[index] = Math.max(120, measured);
        changed = true;
      }
    }
    if (changed) queueHeightRefresh();
  });

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

  function searchTextFor(question) {
    return state.searchAnswers ? question._allNormalized : question._questionNormalized;
  }

  function searchWordsFor(question) {
    return state.searchAnswers ? question._allWords : question._questionWords;
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
      if (distance <= limit) {
        best = Math.min(best, 2 + distance);
      }
      if (best <= 1) break;
    }

    return best;
  }

  function fuzzyScore(question, tokens) {
    const searchText = searchTextFor(question);
    const words = searchWordsFor(question);
    let score = 0;
    for (const token of tokens) {
      const itemScore = tokenScore(searchText, words, token);
      if (!Number.isFinite(itemScore)) return Infinity;
      score += itemScore;
    }
    return score;
  }

  function phraseScore(question, normalizedQuery) {
    if (!normalizedQuery) return 0;
    const index = searchTextFor(question).indexOf(normalizedQuery);
    if (index === -1) return Infinity;
    return index === 0 ? 0 : 1 + index / 10000;
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

  function highlightRangesForTokens(item, textTokens) {
    if (!item.highlightTokens?.length) return [];

    const ranges = [];
    for (const word of textTokens) {
      const shouldHighlight = item.highlightTokens.some((token) =>
        queryTokenMatchesWord(token, word.normalized, item.matchKind)
      );
      if (shouldHighlight) ranges.push({ start: word.start, end: word.end });
    }
    return mergeRanges(ranges);
  }

  function highlightRangesForQuestion(item) {
    return highlightRangesForTokens(item, item.question._questionTokens);
  }

  function highlightRangesForAnswer(item, answer) {
    if (!item.searchAnswers) return [];
    return highlightRangesForTokens(item, answer._tokens || []);
  }

  function mergeRanges(ranges) {
    if (ranges.length < 2) return ranges;
    const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [sorted[0]];
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index];
      const previous = merged[merged.length - 1];
      if (current.start <= previous.end) {
        previous.end = Math.max(previous.end, current.end);
      } else {
        merged.push(current);
      }
    }
    return merged;
  }

  function appendHighlightedText(node, text, ranges) {
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

    if (cursor < text.length) {
      node.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  function renderSections() {
    const fragment = document.createDocumentFragment();
    for (const section of data.sections) {
      const button = document.createElement("button");
      button.className = "section-item";
      button.type = "button";
      button.dataset.section = String(section.id);

      const title = document.createElement("span");
      title.className = "section-title";
      title.textContent = section.sectionName;
      if (section.subname) {
        const subname = document.createElement("span");
        subname.className = "section-subtitle";
        subname.textContent = section.subname;
        title.appendChild(subname);
      }

      const count = document.createElement("span");
      count.className = "section-count";
      count.textContent = numberFormat.format(section.count);

      button.append(title, count);
      fragment.appendChild(button);
    }
    elements.sectionsList.replaceChildren(fragment);

    for (const section of data.sections) {
      const option = document.createElement("option");
      option.value = String(section.id);
      option.textContent = `${section.title} (${numberFormat.format(section.count)})`;
      elements.mobileSectionSelect.appendChild(option);
    }
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
    elements.sectionsToggle.setAttribute(
      "aria-label",
      collapsed ? "Развернуть список тем" : "Свернуть список тем"
    );
    elements.sectionsToggle.title = collapsed ? "Развернуть список тем" : "Свернуть список тем";
    queueRender();
  }

  function currentSectionTitle() {
    if (state.sectionId === "all") return "Все вопросы";
    const section = sectionsById.get(state.sectionId);
    return section ? section.title : "Все вопросы";
  }

  function applyFilters(resetScroll = false) {
    const normalizedQuery = normalize(state.query);
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    const questionSet = state.sectionId === "all" ? null : sectionQuestionSets.get(state.sectionId);
    const phraseMatches = [];
    const wordMatches = [];
    const phraseIds = new Set();

    for (const question of data.questions) {
      if (questionSet && !questionSet.has(question.id)) continue;
      const score = tokens.length ? phraseScore(question, normalizedQuery) : 0;
      if (!Number.isFinite(score)) continue;
      phraseIds.add(question.id);
      phraseMatches.push({
        type: "question",
        question,
        score,
        matchKind: "phrase",
        highlightTokens: tokens,
        searchAnswers: state.searchAnswers,
      });
    }

    if (tokens.length) {
      for (const question of data.questions) {
        if (phraseIds.has(question.id)) continue;
        if (questionSet && !questionSet.has(question.id)) continue;
        const score = fuzzyScore(question, tokens);
        if (!Number.isFinite(score)) continue;
        wordMatches.push({
          type: "question",
          question,
          score,
          matchKind: "words",
          highlightTokens: tokens,
          searchAnswers: state.searchAnswers,
        });
      }
    }

    phraseMatches.sort((a, b) => a.score - b.score || a.question.number - b.question.number);
    wordMatches.sort((a, b) => a.score - b.score || a.question.number - b.question.number);

    const filtered = [...phraseMatches];
    if (tokens.length && wordMatches.length) {
      if (phraseMatches.length) {
        filtered.push({
          type: "separator",
          id: "words-any-order",
          strictCount: phraseMatches.length,
          extraCount: wordMatches.length,
        });
      }
      filtered.push(...wordMatches);
    }

    state.filtered = filtered;
    state.resultQuestionCount = phraseMatches.length + wordMatches.length;
    state.heights = new Array(filtered.length).fill(DEFAULT_HEIGHT);
    resetRenderedRows();
    rebuildOffsets();

    elements.resultCount.textContent = numberFormat.format(state.resultQuestionCount);
    elements.resultLabel.textContent = resultLabel(state.resultQuestionCount);
    elements.activeSection.textContent = currentSectionTitle();
    elements.emptyState.hidden = state.resultQuestionCount !== 0;
    elements.viewport.hidden = state.resultQuestionCount === 0;

    if (resetScroll) elements.viewport.scrollTop = 0;
    queueRender();
  }

  function resultLabel(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "найден";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "найдено";
    return "найдено";
  }

  function rebuildOffsets() {
    state.offsets = new Array(state.filtered.length + 1);
    state.offsets[0] = 0;
    for (let i = 0; i < state.filtered.length; i += 1) {
      state.offsets[i + 1] = state.offsets[i] + (state.heights[i] || DEFAULT_HEIGHT);
    }
    state.totalHeight = state.offsets[state.offsets.length - 1] || 0;
    elements.canvas.style.height = `${state.totalHeight}px`;
  }

  function lowerBound(array, value) {
    let low = 0;
    let high = array.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (array[mid] < value) low = mid + 1;
      else high = mid;
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
    return item.type === "separator"
      ? `separator:${item.id}:${item.extraCount}`
      : `question:${item.question.id}:${item.matchKind}`;
  }

  function renderedKeysFor(start, end) {
    const keys = [];
    for (let index = start; index < end; index += 1) {
      keys.push(itemKeyFor(state.filtered[index]));
    }
    return keys.join("|");
  }

  function updateRenderedRowPositions() {
    for (const row of elements.canvas.children) {
      const index = Number(row.dataset.index);
      if (Number.isFinite(index)) {
        row.style.transform = `translateY(${state.offsets[index]}px)`;
      }
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
      row.appendChild(item.type === "separator" ? renderResultSeparator(item) : renderQuestionCard(item));
      fragment.appendChild(row);
      resizeObserver.observe(row);
    }
    elements.canvas.replaceChildren(fragment);
    state.renderedStart = start;
    state.renderedEnd = end;
    state.renderedKeys = keys;
  }

  function renderResultSeparator(item) {
    const separator = document.createElement("div");
    separator.className = "result-separator";
    return separator;
  }

  function renderQuestionCard(item) {
    const { question } = item;
    const article = document.createElement("article");
    article.className = "question-card";

    const meta = document.createElement("div");
    meta.className = "question-meta";

    const number = document.createElement("span");
    number.className = "question-number";
    number.textContent = `#${question.number}`;

    const section = document.createElement("span");
    section.className = "question-sections";
    section.title = question._sectionNames;
    section.textContent = question._sectionNames;

    meta.append(number, section);

    const text = document.createElement("p");
    text.className = "question-text";
    appendHighlightedText(text, question.question, highlightRangesForQuestion(item));

    article.append(meta, text);

    const imageFile = window.MEDIKTEST_QUESTION_IMAGES?.[question.imageRef];
    if (imageFile) {
      const imageLink = document.createElement("a");
      imageLink.className = "question-image-link";
      imageLink.href = `question-images/${encodeURIComponent(imageFile)}`;
      imageLink.target = "_blank";
      imageLink.rel = "noopener";
      imageLink.setAttribute("aria-label", `Открыть изображение к вопросу ${question.number}`);
      const image = document.createElement("img");
      image.className = "question-image";
      image.src = imageLink.href;
      image.alt = `Изображение к вопросу ${question.number}`;
      image.loading = "lazy";
      image.decoding = "async";
      imageLink.append(image);
      article.append(imageLink);
    }

    const answers = document.createElement("div");
    answers.className = "answers";
    question.answers.forEach((answer, index) => {
      const answerItem = document.createElement("div");
      answerItem.className = `answer${answer.correct ? " is-correct" : ""}`;

      const letter = document.createElement("span");
      letter.className = "answer-letter";
      letter.textContent = letters[index] || String(index + 1);

      const answerText = document.createElement("span");
      appendHighlightedText(answerText, answer.text, highlightRangesForAnswer(item, answer));

      answerItem.append(letter, answerText);
      answers.appendChild(answerItem);
    });
    article.appendChild(answers);

    return article;
  }

  function debounce(callback, delay) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
  }

  function init() {
    elements.questionTotal.textContent = `${numberFormat.format(data.stats.questionCount)} вопросов`;
    elements.sectionTotal.textContent = `${numberFormat.format(data.stats.sectionCount)} темы`;
    elements.allCount.textContent = numberFormat.format(data.stats.questionCount);

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

    elements.viewport.addEventListener("scroll", queueRender, { passive: true });
    window.addEventListener("resize", () => {
      rebuildOffsets();
      queueRender();
    });

    updateSearchPlaceholder();
    applyFilters();
  }

  function updateSearchPlaceholder() {
    elements.searchInput.placeholder = state.searchAnswers
      ? "Поиск по вопросам и ответам"
      : "Поиск только по вопросам";
  }

  init();
})();
