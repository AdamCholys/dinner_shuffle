const DINNERS_API_URL = "/api/dinners";
const PLANS_API_URL = "/api/plans";
const WEEKDAY_HEADERS = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

const dinnerForm = document.querySelector("#dinner-form");
const dinnerInput = document.querySelector("#dinner-input");
const bulkInput = document.querySelector("#bulk-input");
const loadBulkButton = document.querySelector("#load-bulk-button");
const clearDinnersButton = document.querySelector("#clear-dinners-button");
const clearDinnersConfirm = document.querySelector("#clear-dinners-confirm");
const dinnerList = document.querySelector("#dinner-list");
const dinnerCount = document.querySelector("#dinner-count");
const monthInput = document.querySelector("#month-input");
const prevMonthButton = document.querySelector("#prev-month-button");
const nextMonthButton = document.querySelector("#next-month-button");
const soupSpacingInput = document.querySelector("#soup-spacing-input");
const avoidPreviousInput = document.querySelector("#avoid-previous-input");
const generateButton = document.querySelector("#generate-button");
const deletePlanButton = document.querySelector("#delete-plan-button");
const deletePlanConfirm = document.querySelector("#delete-plan-confirm");
const messageBox = document.querySelector("#message-box");
const summaryTitle = document.querySelector("#summary-title");
const summaryText = document.querySelector("#summary-text");
const ruleNotice = document.querySelector("#rule-notice");
const historySection = document.querySelector("#history");
const historyList = document.querySelector("#history-list");
const calendar = document.querySelector("#calendar");
const slotsSection = document.querySelector("#slots-section");
const slotList = document.querySelector("#slot-list");
const dinnerItemTemplate = document.querySelector("#dinner-item-template");

const monthFormatter = new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat("pl-PL", { weekday: "long" });
const shortWeekdayFormatter = new Intl.DateTimeFormat("pl-PL", { weekday: "short" });
const collator = new Intl.Collator("pl-PL");

let dinners = [];
let dinnersVersion = 0;
let plan = null;
let planSummaries = [];
let currentMonthKey = "";
let planRequestId = 0;

// Saves run one at a time so each one sends the version returned by the previous save.
let dinnerQueue = Promise.resolve();
let planQueue = Promise.resolve();

class ConflictError extends Error {
  constructor(current) {
    super("conflict");
    this.current = current;
  }
}

initialize();

async function initialize() {
  attachEventListeners();
  setMessage("Wczytywanie obiadów i planów...");
  currentMonthKey = formatMonthKey(new Date().getFullYear(), new Date().getMonth());
  monthInput.value = currentMonthKey;

  try {
    await Promise.all([loadDinners(), loadPlanSummaries(), loadPlan(currentMonthKey)]);
    setMessage(dinners.length ? "Gotowe." : "Dodaj kilka obiadów, a potem wylosuj plan miesiąca.");
  } catch (error) {
    setMessage(getErrorMessage(error), "error");
  }
}

function attachEventListeners() {
  dinnerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    queueDinnerOp(() => addDinners([dinnerInput.value], { fromForm: true }));
  });

  loadBulkButton.addEventListener("click", () => {
    const candidates = bulkInput.value.split(/\n|,/);
    queueDinnerOp(() => addDinners(candidates, { fromForm: false }));
  });

  clearDinnersButton.addEventListener("click", async () => {
    if (!dinners.length) {
      setMessage("Lista obiadów jest już pusta.");
      return;
    }

    const confirmed = await askConfirm(
      clearDinnersConfirm,
      `Usunąć wszystkie ${dinners.length} ${pluralize(dinners.length, "obiad", "obiady", "obiadów")} z listy? Zapisane plany zostaną bez zmian.`
    );
    if (confirmed) {
      queueDinnerOp(async () => {
        if (await saveDinners([])) {
          setMessage("Wyczyszczono listę obiadów.", "success");
        }
      });
    }
  });

  monthInput.addEventListener("change", () => {
    if (/^\d{4}-\d{2}$/.test(monthInput.value)) {
      openMonth(monthInput.value);
    }
  });
  prevMonthButton.addEventListener("click", () => openMonth(shiftMonthKey(currentMonthKey, -1)));
  nextMonthButton.addEventListener("click", () => openMonth(shiftMonthKey(currentMonthKey, 1)));

  generateButton.addEventListener("click", () => queuePlanOp(generatePlan));

  deletePlanButton.addEventListener("click", async () => {
    if (!plan) {
      return;
    }

    const confirmed = await askConfirm(deletePlanConfirm, `Usunąć plan na ${formatMonthName(currentMonthKey)}?`);
    if (confirmed) {
      queuePlanOp(deletePlan);
    }
  });

  // Pick up changes made on other devices when coming back to the tab.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    try {
      await Promise.all([loadDinners(), loadPlanSummaries(), loadPlan(currentMonthKey)]);
    } catch {
      // A failed background refresh keeps the current view; the next save reports any problem.
    }
  });
}

// ---------------------------------------------------------------------------
// API

async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Nie udało się połączyć z serwerem. Sprawdź połączenie i spróbuj ponownie.");
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 409) {
    throw new ConflictError(data.current);
  }

  if (!response.ok && response.status !== 404) {
    throw new Error(data.error || "Serwer nie mógł zapisać zmian. Spróbuj ponownie.");
  }

  return { status: response.status, data };
}

function queueDinnerOp(operation) {
  dinnerQueue = dinnerQueue.then(operation).catch((error) => setMessage(getErrorMessage(error), "error"));
  return dinnerQueue;
}

function queuePlanOp(operation) {
  planQueue = planQueue.then(operation).catch((error) => setMessage(getErrorMessage(error), "error"));
  return planQueue;
}

// ---------------------------------------------------------------------------
// Dinners

async function loadDinners() {
  const { data } = await api("GET", DINNERS_API_URL);
  applyDinners(data);
}

function applyDinners(data) {
  dinners = Array.isArray(data?.dinners) ? data.dinners : [];
  dinnersVersion = Number.isInteger(data?.version) ? data.version : 0;
  renderDinnerList();
  renderSlots();
}

async function saveDinners(nextDinners) {
  try {
    const { data } = await api("PUT", DINNERS_API_URL, { version: dinnersVersion, dinners: nextDinners });
    applyDinners(data);
    return true;
  } catch (error) {
    if (error instanceof ConflictError) {
      applyDinners(error.current);
      setMessage("Lista obiadów została zmieniona na innym urządzeniu. Wczytano najnowszą wersję, spróbuj ponownie.", "error");
      return false;
    }
    throw error;
  }
}

async function addDinners(candidates, { fromForm }) {
  const nextDinners = [...dinners];
  const added = [];

  candidates.map(normalizeDinner).forEach((candidate) => {
    if (candidate && !containsDinner(nextDinners, candidate)) {
      nextDinners.push(candidate);
      added.push(candidate);
    }
  });

  if (!candidates.some((candidate) => normalizeDinner(candidate))) {
    setMessage(fromForm ? "Nazwa obiadu nie może być pusta." : "Wpisz najpierw przynajmniej jeden obiad.", "error");
    return;
  }

  if (!added.length) {
    setMessage(fromForm ? "Ten obiad jest już na liście." : "Wszystkie te obiady są już na liście.", "error");
    return;
  }

  if (!(await saveDinners(nextDinners))) {
    return;
  }

  if (fromForm) {
    dinnerInput.value = "";
    dinnerInput.focus();
    setMessage(`Dodano „${added[0]}”.`, "success");
  } else {
    bulkInput.value = "";
    setMessage(`Dodano ${added.length} ${pluralize(added.length, "obiad", "obiady", "obiadów")}.`, "success");
  }
}

async function removeDinner(name) {
  if (await saveDinners(dinners.filter((dinner) => dinner !== name))) {
    setMessage(`Usunięto „${name}”.`, "success");
  }
}

function renderDinnerList() {
  dinnerList.innerHTML = "";

  [...dinners].sort(collator.compare).forEach((dinner) => {
    const fragment = dinnerItemTemplate.content.cloneNode(true);
    fragment.querySelector(".dinner-name").textContent = dinner;
    const deleteButton = fragment.querySelector(".delete-button");
    deleteButton.setAttribute("aria-label", `Usuń ${dinner}`);
    deleteButton.addEventListener("click", () => queueDinnerOp(() => removeDinner(dinner)));
    dinnerList.appendChild(fragment);
  });

  const soupCount = dinners.filter(isZupaMeal).length;
  dinnerCount.textContent = `${dinners.length} ${pluralize(dinners.length, "obiad", "obiady", "obiadów")}, w tym ${soupCount} ${pluralize(soupCount, "zupa", "zupy", "zup")}`;
}

// ---------------------------------------------------------------------------
// Plans

async function loadPlanSummaries() {
  const { data } = await api("GET", PLANS_API_URL);
  planSummaries = Array.isArray(data.plans) ? data.plans : [];
  renderHistory();
}

async function loadPlan(monthKey) {
  const requestId = ++planRequestId;
  const { status, data } = await api("GET", `${PLANS_API_URL}/${monthKey}`);

  // Ignore responses for a month the user has already navigated away from.
  if (requestId !== planRequestId) {
    return;
  }

  const previousVersion = plan?.month === monthKey ? plan.version : null;
  plan = status === 404 ? null : data;
  if (plan && plan.version !== previousVersion) {
    soupSpacingInput.value = String(plan.soupSpacing);
  }
  renderPlan();
}

function openMonth(monthKey) {
  currentMonthKey = monthKey;
  monthInput.value = monthKey;
  plan = null;
  renderPlan();
  queuePlanOp(() => loadPlan(monthKey));
}

async function savePlan(slots, soupSpacing) {
  const monthKey = currentMonthKey;
  try {
    const { data } = await api("PUT", `${PLANS_API_URL}/${monthKey}`, {
      version: plan?.version ?? 0,
      soupSpacing,
      slots,
    });
    plan = data;
    upsertSummary(data);
    renderPlan();
    return true;
  } catch (error) {
    if (error instanceof ConflictError) {
      plan = Array.isArray(error.current?.slots) ? error.current : null;
      renderPlan();
      await loadPlanSummaries();
      setMessage("Plan został zmieniony na innym urządzeniu. Wczytano najnowszą wersję, spróbuj ponownie.", "error");
      return false;
    }
    throw error;
  }
}

async function generatePlan() {
  if (!dinners.length) {
    setMessage("Dodaj przynajmniej jeden obiad, zanim wylosujesz plan.", "error");
    return;
  }

  const soupSpacing = getSoupSpacing();
  const slotCount = getSlotCount(currentMonthKey);
  const fixedSlots = Array.from({ length: slotCount }, (_, index) => {
    const slot = plan?.slots[index];
    return slot?.locked ? slot.dinner : null;
  });
  const lockedCount = fixedSlots.filter(Boolean).length;
  const avoid = avoidPreviousInput.checked ? await getPreviousMonthDinners(currentMonthKey) : new Set();

  const dinnersBySlot = buildSlotDinners(slotCount, dinners, soupSpacing, fixedSlots, avoid);
  const slots = dinnersBySlot.map((dinner, index) => ({ dinner, locked: fixedSlots[index] !== null }));
  const hadPlan = Boolean(plan);

  if (await savePlan(slots, soupSpacing)) {
    const lockedNote = lockedCount
      ? ` Zablokowane sloty (${lockedCount}) zostały bez zmian.`
      : "";
    setMessage(
      `${hadPlan ? "Wylosowano ponownie" : "Wylosowano"} plan na ${formatMonthName(currentMonthKey)}.${lockedNote}`,
      "success"
    );
  }
}

async function deletePlan() {
  if (!plan) {
    return;
  }

  try {
    await api("DELETE", `${PLANS_API_URL}/${currentMonthKey}`, { version: plan.version });
    const deletedMonth = currentMonthKey;
    plan = null;
    planSummaries = planSummaries.filter((summary) => summary.month !== deletedMonth);
    renderPlan();
    renderHistory();
    setMessage(`Usunięto plan na ${formatMonthName(deletedMonth)}.`, "success");
  } catch (error) {
    if (error instanceof ConflictError) {
      plan = error.current;
      renderPlan();
      setMessage("Plan został zmieniony na innym urządzeniu. Sprawdź go i spróbuj ponownie.", "error");
      return;
    }
    throw error;
  }
}

async function updateSlot(index, changes, successMessage) {
  if (!plan) {
    return;
  }

  const slots = plan.slots.map((slot, slotIndex) => (slotIndex === index ? { ...slot, ...changes } : slot));
  // Manual edits keep the spacing the plan was generated with, not whatever is typed in the input now.
  if (await savePlan(slots, plan.soupSpacing)) {
    setMessage(successMessage, "success");
  }
}

function rerollSlot(index) {
  if (!plan || plan.slots[index].locked) {
    return;
  }

  const currentDinner = plan.slots[index].dinner;
  const sameCategory = dinners.filter((dinner) => isZupaMeal(dinner) === isZupaMeal(currentDinner));
  const pool = sameCategory.some((dinner) => dinner !== currentDinner) ? sameCategory : dinners;
  const neighbours = [plan.slots[index - 1]?.dinner, plan.slots[index + 1]?.dinner, currentDinner];
  const usage = countUsage(plan.slots.filter((_, slotIndex) => slotIndex !== index).map((slot) => slot.dinner));
  const nextDinner = pickLeastUsed(shuffle(pool), usage, neighbours, { requireExclusion: true });

  if (!nextDinner) {
    setMessage("Nie ma innego obiadu do wylosowania dla tego slotu. Dodaj więcej obiadów do listy.", "error");
    return;
  }

  return updateSlot(index, { dinner: nextDinner }, `Slot ${getSlotRangeLabel(index)}: „${nextDinner}”.`);
}

async function getPreviousMonthDinners(monthKey) {
  const previousKey = shiftMonthKey(monthKey, -1);
  if (!planSummaries.some((summary) => summary.month === previousKey)) {
    return new Set();
  }

  const { status, data } = await api("GET", `${PLANS_API_URL}/${previousKey}`);
  return status === 404 ? new Set() : new Set(data.slots.map((slot) => slot.dinner));
}

function upsertSummary(savedPlan) {
  const summary = { month: savedPlan.month, version: savedPlan.version, updatedAt: savedPlan.updatedAt };
  planSummaries = [...planSummaries.filter((item) => item.month !== savedPlan.month), summary].sort((left, right) =>
    left.month.localeCompare(right.month)
  );
  renderHistory();
}

// ---------------------------------------------------------------------------
// Plan generation

/**
 * Fills every unlocked slot. A zupa goes into a slot once at least `soupSpacing` non-zupa slots
 * have passed since the previous zupa (and there is room before the next locked zupa); every
 * other slot gets a non-zupa dish. Within a category the least used dish wins, preferring dishes
 * not eaten last month and never repeating the dish of a neighbouring slot when avoidable.
 */
function buildSlotDinners(slotCount, mealOptions, soupSpacing, fixedSlots, avoid) {
  const preferFresh = (meals) => shuffle(meals).sort((left, right) => Number(avoid.has(left)) - Number(avoid.has(right)));
  const soups = preferFresh(mealOptions.filter(isZupaMeal));
  const others = preferFresh(mealOptions.filter((meal) => !isZupaMeal(meal)));
  const result = [...fixedSlots];
  const usage = countUsage(fixedSlots.filter(Boolean));
  let lastSoupIndex = -Infinity;

  for (let index = 0; index < slotCount; index += 1) {
    if (result[index] !== null) {
      if (isZupaMeal(result[index])) {
        lastSoupIndex = index;
      }
      continue;
    }

    const nextLockedSoup = result.findIndex((dinner, slotIndex) => slotIndex > index && dinner && isZupaMeal(dinner));
    const roomBeforeNextSoup = nextLockedSoup === -1 || nextLockedSoup - index - 1 >= soupSpacing;
    const soupDue = index - lastSoupIndex - 1 >= soupSpacing && roomBeforeNextSoup;
    const useSoup = soups.length > 0 && (soupDue || others.length === 0);

    const pool = useSoup ? soups : others;
    const dinner = pickLeastUsed(pool, usage, [result[index - 1], result[index + 1]]);
    result[index] = dinner;
    usage.set(dinner, (usage.get(dinner) || 0) + 1);
    if (useSoup) {
      lastSoupIndex = index;
    }
  }

  return result;
}

function pickLeastUsed(pool, usage, exclude, { requireExclusion = false } = {}) {
  const allowed = pool.filter((meal) => !exclude.includes(meal));
  const candidates = allowed.length || requireExclusion ? allowed : pool;
  let best = null;

  candidates.forEach((meal) => {
    if (best === null || (usage.get(meal) || 0) < (usage.get(best) || 0)) {
      best = meal;
    }
  });

  return best;
}

function countUsage(meals) {
  const usage = new Map();
  meals.forEach((meal) => usage.set(meal, (usage.get(meal) || 0) + 1));
  return usage;
}

function findSpacingIssues(slots, soupSpacing) {
  const issues = [];
  let lastSoupIndex = null;

  slots.forEach((slot, index) => {
    if (!isZupaMeal(slot.dinner)) {
      return;
    }
    if (lastSoupIndex !== null && index - lastSoupIndex - 1 < soupSpacing) {
      issues.push([lastSoupIndex, index]);
    }
    lastSoupIndex = index;
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Rendering

function renderPlan() {
  renderSummary();
  renderCalendar();
  renderSlots();
  renderHistory();

  const lockedCount = plan ? plan.slots.filter((slot) => slot.locked).length : 0;
  generateButton.textContent = !plan
    ? "Wylosuj plan"
    : lockedCount
      ? `Losuj ponownie (bez ${lockedCount} ${pluralize(lockedCount, "zablokowanego", "zablokowanych", "zablokowanych")})`
      : "Losuj ponownie";
  deletePlanButton.hidden = !plan;
  if (!plan) {
    deletePlanConfirm.hidden = true;
  }
}

function renderSummary() {
  summaryTitle.textContent = capitalize(formatMonthName(currentMonthKey));
  ruleNotice.hidden = true;

  if (!plan) {
    summaryText.textContent = dinners.length
      ? "Na ten miesiąc nie ma jeszcze planu. Kliknij „Wylosuj plan”."
      : "Dodaj obiady i wylosuj plan, aby zacząć.";
    return;
  }

  const days = getDaysInMonth(plan.month);
  const uniqueCount = new Set(plan.slots.map((slot) => slot.dinner)).size;
  const soupSlots = plan.slots.filter((slot) => isZupaMeal(slot.dinner)).length;
  summaryText.textContent = `${days} dni w ${plan.slots.length} ${pluralize(plan.slots.length, "slocie", "slotach", "slotach")}: ${uniqueCount} ${pluralize(uniqueCount, "różny obiad", "różne obiady", "różnych obiadów")}, ${soupSlots} ${pluralize(soupSlots, "slot", "sloty", "slotów")} z zupą.`;

  const hasNonSoups = plan.slots.some((slot) => !isZupaMeal(slot.dinner)) || dinners.some((dinner) => !isZupaMeal(dinner));
  const issues = hasNonSoups ? findSpacingIssues(plan.slots, plan.soupSpacing) : [];
  if (issues.length) {
    const places = issues.map(([left, right]) => `${getSlotRangeLabel(left)} i ${getSlotRangeLabel(right)}`).join("; ");
    ruleNotice.textContent = `Zupy są bliżej siebie niż ${plan.soupSpacing} ${pluralize(plan.soupSpacing, "obiad", "obiady", "obiadów")} odstępu (dni ${places}). Możesz to tak zostawić albo przelosować te sloty.`;
    ruleNotice.hidden = false;
  }
}

function renderCalendar() {
  calendar.innerHTML = "";
  if (!plan) {
    return;
  }

  WEEKDAY_HEADERS.forEach((label) => {
    const header = document.createElement("div");
    header.className = "calendar-head";
    header.textContent = label;
    calendar.appendChild(header);
  });

  const { year, monthIndex } = parseMonthKey(plan.month);
  const leadingBlanks = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  for (let blank = 0; blank < leadingBlanks; blank += 1) {
    const spacer = document.createElement("div");
    spacer.className = "calendar-blank";
    calendar.appendChild(spacer);
  }

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === monthIndex;

  for (let day = 1; day <= getDaysInMonth(plan.month); day += 1) {
    const slotIndex = Math.floor((day - 1) / 2);
    const slot = plan.slots[slotIndex];
    const date = new Date(year, monthIndex, day);
    const zupa = isZupaMeal(slot.dinner);

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `calendar-day slot-tone-${slotIndex % 2}${zupa ? " is-zupa" : ""}${slot.locked ? " is-locked" : ""}`;
    if (isCurrentMonth && today.getDate() === day) {
      cell.classList.add("is-today");
    }
    cell.dataset.slot = String(slotIndex);
    cell.setAttribute("aria-label", `${day} ${weekdayFormatter.format(date)}: ${slot.dinner}. Pokaż slot.`);

    const top = document.createElement("span");
    top.className = "calendar-day-top";
    const dayNumber = document.createElement("span");
    dayNumber.className = "calendar-day-number";
    dayNumber.textContent = String(day);
    const weekday = document.createElement("span");
    weekday.className = "calendar-weekday";
    weekday.textContent = weekdayFormatter.format(date);
    top.append(dayNumber, weekday);
    if (slot.locked) {
      const lock = document.createElement("span");
      lock.className = "calendar-lock";
      lock.textContent = "🔒";
      lock.setAttribute("aria-hidden", "true");
      top.append(lock);
    }

    const meal = document.createElement("span");
    meal.className = "calendar-meal";
    meal.textContent = slot.dinner;

    cell.append(top, meal);
    cell.addEventListener("click", () => focusSlot(slotIndex));
    cell.addEventListener("mouseenter", () => highlightSlot(slotIndex, true));
    cell.addEventListener("mouseleave", () => highlightSlot(slotIndex, false));
    calendar.appendChild(cell);
  }
}

function renderSlots() {
  slotList.innerHTML = "";
  slotsSection.hidden = !plan;
  if (!plan) {
    return;
  }

  plan.slots.forEach((slot, index) => {
    const item = document.createElement("li");
    item.className = `slot-row${slot.locked ? " is-locked" : ""}`;
    item.dataset.slot = String(index);

    const range = document.createElement("div");
    range.className = "slot-range";
    const rangeDays = document.createElement("strong");
    rangeDays.textContent = getSlotRangeLabel(index);
    const rangeWeekdays = document.createElement("span");
    rangeWeekdays.textContent = getSlotWeekdaysLabel(index);
    range.append(rangeDays, rangeWeekdays);

    const badge = document.createElement("span");
    const zupa = isZupaMeal(slot.dinner);
    badge.className = `category-badge ${zupa ? "is-zupa" : "is-non-zupa"}`;
    badge.title = zupa ? "Zupa" : "Danie";
    badge.innerHTML = zupa ? getSoupIconMarkup() : getMealIconMarkup();

    const select = document.createElement("select");
    select.className = "meal-editor";
    select.setAttribute("aria-label", `Obiad na dni ${getSlotRangeLabel(index)}`);
    buildMealOptions(select, slot.dinner);
    select.addEventListener("change", () => {
      const nextDinner = select.value;
      queuePlanOp(() => updateSlot(index, { dinner: nextDinner }, `Slot ${getSlotRangeLabel(index)}: „${nextDinner}”.`));
    });

    const lockButton = document.createElement("button");
    lockButton.type = "button";
    lockButton.className = "icon-button lock-button";
    lockButton.textContent = slot.locked ? "🔒" : "🔓";
    lockButton.setAttribute("aria-pressed", String(slot.locked));
    lockButton.title = slot.locked ? "Odblokuj slot" : "Zablokuj slot przy ponownym losowaniu";
    lockButton.setAttribute("aria-label", `${lockButton.title} ${getSlotRangeLabel(index)}`);
    lockButton.addEventListener("click", () =>
      queuePlanOp(() =>
        updateSlot(
          index,
          { locked: !slot.locked },
          slot.locked ? `Odblokowano slot ${getSlotRangeLabel(index)}.` : `Zablokowano slot ${getSlotRangeLabel(index)}.`
        )
      )
    );

    const rerollButton = document.createElement("button");
    rerollButton.type = "button";
    rerollButton.className = "icon-button";
    rerollButton.textContent = "🎲";
    rerollButton.disabled = slot.locked;
    rerollButton.title = slot.locked ? "Odblokuj slot, aby go przelosować" : "Wylosuj inny obiad dla tego slotu";
    rerollButton.setAttribute("aria-label", `Przelosuj slot ${getSlotRangeLabel(index)}`);
    rerollButton.addEventListener("click", () => queuePlanOp(() => rerollSlot(index)));

    item.append(range, badge, select, lockButton, rerollButton);
    item.addEventListener("mouseenter", () => highlightSlot(index, true));
    item.addEventListener("mouseleave", () => highlightSlot(index, false));
    slotList.appendChild(item);
  });
}

function buildMealOptions(select, selectedDinner) {
  const options = [...new Set([...dinners, selectedDinner])].sort(collator.compare);
  const groups = [
    ["Zupy", options.filter(isZupaMeal)],
    ["Pozostałe dania", options.filter((dinner) => !isZupaMeal(dinner))],
  ];

  groups.forEach(([label, meals]) => {
    if (!meals.length) {
      return;
    }
    const group = document.createElement("optgroup");
    group.label = label;
    meals.forEach((meal) => {
      const option = document.createElement("option");
      option.value = meal;
      option.textContent = dinners.includes(meal) ? meal : `${meal} (spoza listy)`;
      option.selected = meal === selectedDinner;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
}

function renderHistory() {
  historyList.innerHTML = "";
  historySection.hidden = !planSummaries.length;

  [...planSummaries].reverse().forEach((summary) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `history-chip${summary.month === currentMonthKey ? " is-active" : ""}`;
    chip.textContent = capitalize(formatMonthName(summary.month));
    chip.addEventListener("click", () => openMonth(summary.month));
    historyList.appendChild(chip);
  });
}

function focusSlot(index) {
  const row = slotList.querySelector(`[data-slot="${index}"]`);
  if (!row) {
    return;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.querySelector("select").focus({ preventScroll: true });
}

function highlightSlot(index, active) {
  document.querySelectorAll(`[data-slot="${index}"]`).forEach((element) => {
    element.classList.toggle("is-highlighted", active);
  });
}

function setMessage(text, state = "default") {
  messageBox.textContent = text;
  messageBox.dataset.state = state;
}

function askConfirm(bar, text) {
  bar.pendingResolve?.(false);
  bar.querySelector(".confirm-text").textContent = text;
  bar.hidden = false;

  return new Promise((resolve) => {
    const controller = new AbortController();
    bar.pendingResolve = (answer) => {
      controller.abort();
      bar.pendingResolve = null;
      bar.hidden = true;
      resolve(answer);
    };
    bar.querySelectorAll("[data-answer]").forEach((button) => {
      button.addEventListener("click", () => bar.pendingResolve(button.dataset.answer === "yes"), {
        signal: controller.signal,
      });
    });
    bar.querySelector('[data-answer="no"]').focus();
  });
}

// ---------------------------------------------------------------------------
// Helpers

function normalizeDinner(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim();
}

function containsDinner(list, name) {
  const lowered = name.toLocaleLowerCase("pl-PL");
  return list.some((dinner) => dinner.toLocaleLowerCase("pl-PL") === lowered);
}

function isZupaMeal(mealName) {
  return mealName.trim().toLocaleLowerCase("pl-PL").startsWith("zupa");
}

function getSoupSpacing() {
  const value = Number(soupSpacingInput.value);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 6) : 1;
}

function pluralize(count, one, few, many) {
  if (count === 1) {
    return one;
  }
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14) ? few : many;
}

function capitalize(text) {
  return text.charAt(0).toLocaleUpperCase("pl-PL") + text.slice(1);
}

function formatMonthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function parseMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return { year, monthIndex: month - 1 };
}

function shiftMonthKey(monthKey, delta) {
  const { year, monthIndex } = parseMonthKey(monthKey);
  const date = new Date(year, monthIndex + delta, 1);
  return formatMonthKey(date.getFullYear(), date.getMonth());
}

function formatMonthName(monthKey) {
  const { year, monthIndex } = parseMonthKey(monthKey);
  return monthFormatter.format(new Date(year, monthIndex, 1));
}

function getDaysInMonth(monthKey) {
  const { year, monthIndex } = parseMonthKey(monthKey);
  return new Date(year, monthIndex + 1, 0).getDate();
}

function getSlotCount(monthKey) {
  return Math.ceil(getDaysInMonth(monthKey) / 2);
}

function getSlotDays(index) {
  const first = index * 2 + 1;
  return [first, Math.min(first + 1, getDaysInMonth(currentMonthKey))];
}

function getSlotRangeLabel(index) {
  const [first, last] = getSlotDays(index);
  return first === last ? `${first}` : `${first}–${last}`;
}

function getSlotWeekdaysLabel(index) {
  const { year, monthIndex } = parseMonthKey(currentMonthKey);
  const [first, last] = getSlotDays(index);
  const names = [...new Set([first, last])].map((day) => shortWeekdayFormatter.format(new Date(year, monthIndex, day)));
  return names.join("–");
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Coś poszło nie tak. Spróbuj ponownie.";
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function getSoupIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" class="category-icon" aria-hidden="true" focusable="false">
      <path d="M5 10.5c0 3.6 3 6.5 7 6.5s7-2.9 7-6.5V10H5Z" fill="currentColor" opacity="0.2"></path>
      <path d="M4 10h16c0 4.4-3.6 8-8 8s-8-3.6-8-8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
      <path d="M8 19.5h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M9 6.5c0-.9.7-1.4.7-2.3S9 2.8 9 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
      <path d="M12 7c0-.9.7-1.4.7-2.3S12 3.3 12 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
      <path d="M15 6.5c0-.9.7-1.4.7-2.3S15 2.8 15 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
    </svg>
  `;
}

function getMealIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" class="category-icon" aria-hidden="true" focusable="false">
      <path d="M5 11.5c.4-3 3.2-5 7-5s6.6 2 7 5" fill="currentColor" opacity="0.18"></path>
      <path d="M5 11.5c.4-3 3.2-5 7-5s6.6 2 7 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M4.5 13.5h15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M5.2 15.3h13.6c-.5 2.2-2.4 3.7-4.7 3.7H9.9c-2.3 0-4.2-1.5-4.7-3.7Z" fill="currentColor" opacity="0.18"></path>
      <path d="M5.2 15.3h13.6c-.5 2.2-2.4 3.7-4.7 3.7H9.9c-2.3 0-4.2-1.5-4.7-3.7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
      <path d="M8 11.3v.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M12 10.6v.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M16 11.3v.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
    </svg>
  `;
}
