(() => {
  "use strict";

  const script = document.currentScript;
  const kind = script?.dataset.kind === "tasks" ? "tasks" : "questions";
  const catalogUrl = "site-data/catalog.json";
  const defaultCourseId = "lechebnoe_delo_2019";
  const numberFormat = new Intl.NumberFormat("ru-RU");

  const elements = {
    button: document.getElementById("coursePickerButton"),
    title: document.getElementById("courseTitle"),
    section: document.getElementById("courseSection"),
    status: document.getElementById("courseLoadStatus"),
  };

  function normalize(value) {
    return String(value || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setStatus(text, tone = "loading") {
    if (!elements.status) return;
    elements.status.hidden = !text;
    elements.status.textContent = text || "";
    elements.status.dataset.tone = tone;
  }

  function appendScript(src) {
    return new Promise((resolve, reject) => {
      const child = document.createElement("script");
      child.src = src;
      child.onload = resolve;
      child.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
      document.body.append(child);
    });
  }

  async function readCompressedJson(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let decoded;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (!("DecompressionStream" in window)) {
        throw new Error("Браузер не поддерживает распаковку gzip");
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      decoded = await new Response(stream).text();
    } else {
      decoded = new TextDecoder().decode(bytes);
    }
    return JSON.parse(decoded);
  }

  function selectedCourse(catalog) {
    const params = new URLSearchParams(location.search);
    const requested = params.get("course") || localStorage.getItem("mediktest-course") || defaultCourseId;
    return catalog.courses.find((course) => course.id === requested)
      || catalog.courses.find((course) => course.id === defaultCourseId)
      || catalog.courses[0];
  }

  function updateChrome(course) {
    elements.title.textContent = course.name;
    elements.section.textContent = course.sectionName;
    document.title = `MedikTest — ${course.name}`;
    localStorage.setItem("mediktest-course", course.id);
    for (const link of document.querySelectorAll(".content-tab")) {
      const target = new URL(link.getAttribute("href"), location.href);
      target.searchParams.set("course", course.id);
      link.href = `${target.pathname.split("/").pop()}${target.search}`;
    }
  }

  function createPicker(catalog, currentCourse) {
    const dialog = document.createElement("dialog");
    dialog.className = "course-dialog";
    dialog.setAttribute("aria-labelledby", "courseDialogTitle");
    dialog.innerHTML = `
      <div class="course-dialog-header">
        <div>
          <h2 id="courseDialogTitle">Выбор специальности</h2>
          <p>${numberFormat.format(catalog.stats.courseCount)} баз — поиск работает внутри выбранной базы</p>
        </div>
        <button class="course-dialog-close" type="button" aria-label="Закрыть">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <label class="course-dialog-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
        <input type="search" autocomplete="off" spellcheck="false" placeholder="Специальность или раздел">
      </label>
      <div class="course-dialog-summary"></div>
      <div class="course-dialog-list"></div>
    `;
    document.body.append(dialog);

    const input = dialog.querySelector("input");
    const list = dialog.querySelector(".course-dialog-list");
    const summary = dialog.querySelector(".course-dialog-summary");
    const normalized = new Map(
      catalog.courses.map((course) => [course.id, normalize(`${course.name} ${course.sectionName}`)])
    );

    function render() {
      const query = normalize(input.value);
      const filtered = query
        ? catalog.courses.filter((course) => normalized.get(course.id).includes(query))
        : catalog.courses;
      summary.textContent = query
        ? `Найдено: ${numberFormat.format(filtered.length)}`
        : "Разделы и специальности";
      list.replaceChildren();

      for (const section of catalog.sections) {
        const courses = filtered.filter((course) => course.sectionName === section);
        if (!courses.length) continue;
        const group = document.createElement("section");
        group.className = "course-dialog-group";
        const heading = document.createElement("h3");
        heading.textContent = section;
        group.append(heading);
        const items = document.createElement("div");
        items.className = "course-dialog-items";
        for (const course of courses) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "course-dialog-item";
          if (course.id === currentCourse.id) button.classList.add("is-current");
          const countLabel = kind === "tasks"
            ? `${numberFormat.format(course.caseCount)} задач`
            : `${numberFormat.format(course.questionCount)} вопросов`;
          button.innerHTML = `
            <span class="course-dialog-item-name"></span>
            <span class="course-dialog-item-meta">${countLabel}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          `;
          button.querySelector(".course-dialog-item-name").textContent = course.name;
          button.addEventListener("click", () => {
            const url = new URL(location.href);
            url.searchParams.set("course", course.id);
            location.href = url.href;
          });
          items.append(button);
        }
        group.append(items);
        list.append(group);
      }

      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "course-dialog-empty";
        empty.textContent = "Ничего не найдено. Проверьте написание специальности.";
        list.append(empty);
      }
    }

    elements.button.addEventListener("click", () => {
      render();
      dialog.showModal();
      requestAnimationFrame(() => input.focus());
    });
    dialog.querySelector(".course-dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    input.addEventListener("input", render);
  }

  async function useFallback(error) {
    console.warn("Не удалось загрузить общий каталог, используется встроенная база", error);
    setStatus("Локальная копия", "warning");
    if (kind === "tasks") {
      await appendScript("tasks-data.js");
      await appendScript("tasks.js");
    } else {
      await appendScript("data.js");
      await appendScript("app.js");
    }
  }

  async function start() {
    try {
      setStatus("Загрузка базы…");
      const catalogResponse = await fetch(catalogUrl, { cache: "no-cache" });
      if (!catalogResponse.ok) throw new Error(`HTTP ${catalogResponse.status}: ${catalogUrl}`);
      const catalog = await catalogResponse.json();
      const course = selectedCourse(catalog);
      if (!course) throw new Error("В каталоге нет специальностей");
      updateChrome(course);
      createPicker(catalog, course);
      const payload = await readCompressedJson(`site-data/${course.dataPath}`);

      if (kind === "tasks") {
        window.MEDIKTEST_TASKS = {
          course: payload.course,
          topics: payload.topics,
          cases: payload.cases,
          stats: payload.stats,
        };
        await appendScript("tasks.js");
      } else {
        window.MEDIKTEST_DATA = {
          course: payload.course,
          sections: payload.sections,
          questions: payload.questions,
          stats: payload.stats,
        };
        await appendScript("app.js");
      }
      setStatus("");
    } catch (error) {
      await useFallback(error);
    }
  }

  start();
})();
