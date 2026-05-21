const DINNERS_API_URL = "/api/dinners";
const LATEST_PLAN_API_URL = "/api/latest-plan";
const SERVER_START_COMMAND = "python3 server.py";

const dinnerForm = document.querySelector("#dinner-form");
const dinnerInput = document.querySelector("#dinner-input");
const bulkInput = document.querySelector("#bulk-input");
const loadBulkButton = document.querySelector("#load-bulk-button");
const clearDinnersButton = document.querySelector("#clear-dinners-button");
const dinnerList = document.querySelector("#dinner-list");
const dinnerCount = document.querySelector("#dinner-count");
const monthInput = document.querySelector("#month-input");
const soupSpacingInput = document.querySelector("#soup-spacing-input");
const generateButton = document.querySelector("#generate-button");
const shuffleButton = document.querySelector("#shuffle-button");
const messageBox = document.querySelector("#message-box");
const calendar = document.querySelector("#calendar");
const summaryTitle = document.querySelector("#summary-title");
const summaryText = document.querySelector("#summary-text");
const dinnerItemTemplate = document.querySelector("#dinner-item-template");

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const monthFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

let dinners = [];
let currentPlan = [];

initialize();

async function initialize() {
  setDefaultMonth();
  attachEventListeners();
  setMessage("Loading saved dinners and latest plan...");
  await Promise.all([refreshDinners(), refreshLatestPlan()]);
}

function attachEventListeners() {
  dinnerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addDinner(dinnerInput.value);
  });

  loadBulkButton.addEventListener("click", async () => {
    const candidates = bulkInput.value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (!candidates.length) {
      setMessage("Add at least one dinner in the bulk list first.", "error");
      return;
    }

    const nextDinners = [...dinners];
    let addedCount = 0;

    candidates.forEach((candidate) => {
      const normalized = normalizeDinner(candidate);
      const exists = nextDinners.some(
        (dinner) => dinner.toLocaleLowerCase() === normalized.toLocaleLowerCase()
      );

      if (normalized && !exists) {
        nextDinners.push(normalized);
        addedCount += 1;
      }
    });

    if (!addedCount) {
      setMessage("No new dinners were added because they were already in the list.", "error");
      return;
    }

    bulkInput.value = "";
    await saveDinners(nextDinners);
    renderDinnerList();
    setMessage(`Loaded ${addedCount} dinner${addedCount === 1 ? "" : "s"}.`, "success");
  });

  clearDinnersButton.addEventListener("click", async () => {
    try {
      await saveDinners([]);
      currentPlan = [];
      renderDinnerList();
      renderCalendar([]);
      updateSummary(null);
      setMessage("Cleared all dinners.", "success");
    } catch {
      setMessage("Could not clear dinners right now.", "error");
    }
  });

  generateButton.addEventListener("click", generatePlan);
  shuffleButton.addEventListener("click", generatePlan);
}

async function addDinner(value) {
  const normalized = normalizeDinner(value);

  if (!normalized) {
    setMessage("Dinner names cannot be empty.", "error");
    return false;
  }

  const exists = dinners.some(
    (dinner) => dinner.toLocaleLowerCase() === normalized.toLocaleLowerCase()
  );

  if (exists) {
    setMessage("That dinner is already in the list.", "error");
    return false;
  }

  try {
    await saveDinners([...dinners, normalized]);
    renderDinnerList();
    dinnerInput.value = "";
    dinnerInput.focus();
    setMessage(`Added “${normalized}”.`, "success");
  } catch {
    setMessage("Could not save that dinner right now.", "error");
    return false;
  }

  return true;
}

function normalizeDinner(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim();
}

async function removeDinner(index) {
  const removedDinner = dinners[index];

  try {
    await saveDinners(dinners.filter((_, dinnerIndex) => dinnerIndex !== index));
    renderDinnerList();
    setMessage(`Removed “${removedDinner}”.`, "success");
  } catch {
    setMessage("Could not remove that dinner right now.", "error");
  }
}

function renderDinnerList() {
  dinnerList.innerHTML = "";

  dinners.forEach((dinner, index) => {
    const fragment = dinnerItemTemplate.content.cloneNode(true);
    fragment.querySelector(".dinner-name").textContent = dinner;
    fragment.querySelector(".delete-button").addEventListener("click", async () => {
      await removeDinner(index);
    });
    dinnerList.appendChild(fragment);
  });

  dinnerCount.textContent = `${dinners.length} meal${dinners.length === 1 ? "" : "s"}`;
}

async function generatePlan() {
  if (!dinners.length) {
    setMessage("Add at least one dinner before generating a plan.", "error");
    return;
  }

  if (!monthInput.value) {
    setMessage("Select a month before generating a plan.", "error");
    return;
  }

  const [yearValue, monthValue] = monthInput.value.split("-");
  const year = Number(yearValue);
  const month = Number(monthValue) - 1;

  if (Number.isNaN(year) || Number.isNaN(month)) {
    setMessage("The selected month is invalid.", "error");
    return;
  }

  const soupSpacing = getSoupSpacing();
  currentPlan = buildMonthlyPlan(year, month, dinners, soupSpacing);

  try {
    await saveLatestPlan({
      year,
      month,
      soupSpacing,
      dinners,
      plan: currentPlan,
    });
    renderCalendar(currentPlan);
    updateSummary({ year, month, plan: currentPlan });
    setMessage(`Generated a ${monthFormatter.format(new Date(year, month, 1))} plan.`, "success");
  } catch {
    setMessage("Could not save the latest plan right now.", "error");
  }
}

function buildMonthlyPlan(year, month, mealOptions, soupSpacing) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const twoDayBlocks = Math.ceil(daysInMonth / 2);
  const rotatedMeals = buildSlotMeals(twoDayBlocks, mealOptions, soupSpacing);

  const plan = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const blockIndex = Math.floor((day - 1) / 2);
    const assignedDinner = rotatedMeals[blockIndex];
    const date = new Date(year, month, day);
    plan.push({
      day,
      weekday: weekdayFormatter.format(date),
      dinner: assignedDinner,
      blockLabel: `${blockIndex * 2 + 1}-${Math.min(blockIndex * 2 + 2, daysInMonth)}`,
    });
  }

  return plan;
}

function renderCalendar(plan) {
  calendar.innerHTML = "";

  if (!plan.length) {
    return;
  }

  plan.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "day-card";

    const dayNumber = document.createElement("span");
    dayNumber.className = "day-number";
    dayNumber.textContent = String(entry.day);

    const weekday = document.createElement("span");
    weekday.className = "weekday";
    weekday.textContent = entry.weekday;

    const mealName = document.createElement("div");
    mealName.className = "meal-name";
    mealName.textContent = entry.dinner;

    const mealMeta = document.createElement("div");
    mealMeta.className = "meal-meta";

    const categoryBadge = document.createElement("span");
    categoryBadge.className = `category-badge ${isZupaMeal(entry.dinner) ? "is-zupa" : "is-non-zupa"}`;
    categoryBadge.setAttribute("aria-label", isZupaMeal(entry.dinner) ? "Zupa meal" : "Non-zupa meal");
    categoryBadge.innerHTML = isZupaMeal(entry.dinner) ? getSoupIconMarkup() : getMealIconMarkup();

    mealMeta.append(mealName, categoryBadge);

    const mealEditorLabel = document.createElement("label");
    mealEditorLabel.className = "meal-editor-label";
    mealEditorLabel.textContent = "Change dinner";

    const mealEditor = document.createElement("select");
    mealEditor.className = "meal-editor";
    mealEditor.setAttribute("aria-label", `Change dinner for slot ${entry.blockLabel}`);

    buildMealEditorOptions(mealEditor, entry.dinner);
    mealEditor.addEventListener("change", async (event) => {
      const nextDinner = event.target.value;
      await updatePlanDinner(entry.blockLabel, nextDinner);
    });

    const dayRange = document.createElement("span");
    dayRange.className = "day-range";
    dayRange.textContent = `2-day slot ${entry.blockLabel}`;

    card.append(dayNumber, weekday, mealMeta, mealEditorLabel, mealEditor, dayRange);
    calendar.appendChild(card);
  });
}

function updateSummary(payload) {
  if (!payload) {
    summaryTitle.textContent = "No month generated yet";
    summaryText.textContent = "Add dinners and generate a schedule to begin.";
    return;
  }

  const uniqueDinnersUsed = new Set(payload.plan.map((entry) => entry.dinner)).size;
  const monthDate = new Date(payload.year, payload.month, 1);
  summaryTitle.textContent = monthFormatter.format(monthDate);
  summaryText.textContent = `${payload.plan.length} days planned across ${Math.ceil(
    payload.plan.length / 2
  )} two-day slots using ${uniqueDinnersUsed} dinner${uniqueDinnersUsed === 1 ? "" : "s"}.`;
}

function setMessage(text, state = "default") {
  messageBox.textContent = text;
  messageBox.dataset.state = state;
}

async function refreshDinners() {
  try {
    const response = await fetch(DINNERS_API_URL);

    if (!response.ok) {
      throw createStorageError(response.status);
    }

    const payload = await response.json();
    dinners = Array.isArray(payload.dinners) ? payload.dinners : [];
    renderDinnerList();
    if (currentPlan.length) {
      renderCalendar(currentPlan);
      updateSummary({
        year: getCurrentPlanYear(),
        month: getCurrentPlanMonth(),
        plan: currentPlan,
      });
    }
    setMessage("Add at least one dinner, then generate a monthly plan.");
  } catch (error) {
    dinners = [];
    renderDinnerList();
    setMessage(getErrorMessage(error), "error");
  }
}

async function refreshLatestPlan() {
  try {
    const response = await fetch(LATEST_PLAN_API_URL);

    if (!response.ok) {
      throw createStorageError(response.status);
    }

    const payload = await response.json();

    if (shouldRepairLatestPlan(payload)) {
      const repairedPlan = buildMonthlyPlan(
        payload.year,
        payload.month,
        payload.dinners,
        normalizeSoupSpacing(payload.soupSpacing)
      );

      await saveLatestPlan({
        year: payload.year,
        month: payload.month,
        soupSpacing: normalizeSoupSpacing(payload.soupSpacing),
        dinners: payload.dinners,
        plan: repairedPlan,
      });
      setMessage("Repaired an older saved plan to match the zupa spacing rule.", "success");
      return;
    }

    applyLatestPlan(payload);
  } catch (error) {
    renderCalendar([]);
    updateSummary(null);
    if (!messageBox.textContent || messageBox.dataset.state !== "error") {
      setMessage(getErrorMessage(error), "error");
    }
  }
}

function shouldRepairLatestPlan(payload) {
  if (!payload || !Array.isArray(payload.plan) || !payload.plan.length) {
    return false;
  }

  if (!Array.isArray(payload.dinners) || !payload.dinners.length) {
    return false;
  }

  const soupSpacing = normalizeSoupSpacing(payload.soupSpacing);
  const inspectedSlots = new Map();

  for (const entry of payload.plan) {
    if (!entry || typeof entry.blockLabel !== "string") {
      return true;
    }

    if (inspectedSlots.has(entry.blockLabel)) {
      continue;
    }

    inspectedSlots.set(entry.blockLabel, entry.dinner);
  }

  const orderedSlots = [...inspectedSlots.entries()].sort((left, right) => {
    const leftStart = Number(left[0].split("-")[0]);
    const rightStart = Number(right[0].split("-")[0]);
    return leftStart - rightStart;
  });

  const pattern = ["soup", ...Array.from({ length: soupSpacing }, () => "nonSoup")];

  return orderedSlots.some(([_, dinner], index) => {
    const expectedCategory = pattern[index % pattern.length];
    return expectedCategory === "soup" ? !isZupaMeal(dinner) : isZupaMeal(dinner);
  });
}

async function saveDinners(nextDinners) {
  const response = await fetch(DINNERS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dinners: nextDinners }),
  });

  if (!response.ok) {
    throw createStorageError(response.status);
  }

  const payload = await response.json();
  dinners = Array.isArray(payload.dinners) ? payload.dinners : [];
}

async function saveLatestPlan(planPayload) {
  const response = await fetch(LATEST_PLAN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(planPayload),
  });

  if (!response.ok) {
    throw createStorageError(response.status);
  }

  const payload = await response.json();
  applyLatestPlan(payload);
}

async function updatePlanDinner(blockLabel, nextDinner) {
  if (!currentPlan.length) {
    return;
  }

  const normalizedDinner = normalizeDinner(nextDinner);
  if (!normalizedDinner) {
    setMessage("Dinner names cannot be empty.", "error");
    renderCalendar(currentPlan);
    return;
  }

  const nextPlan = currentPlan.map((entry) => {
    if (entry.blockLabel !== blockLabel) {
      return entry;
    }

    return {
      ...entry,
      dinner: normalizedDinner,
    };
  });

  try {
    await saveLatestPlan({
      year: getCurrentPlanYear(),
      month: getCurrentPlanMonth(),
      soupSpacing: getSoupSpacing(),
      dinners,
      plan: nextPlan,
    });
    setMessage(`Updated slot ${blockLabel} to “${normalizedDinner}”.`, "success");
  } catch {
    renderCalendar(currentPlan);
    setMessage("Could not save that plan change right now.", "error");
  }
}

function applyLatestPlan(payload) {
  if (!payload || !Array.isArray(payload.plan) || payload.year === null || payload.month === null) {
    currentPlan = [];
    renderCalendar([]);
    updateSummary(null);
    return;
  }

  currentPlan = payload.plan;
  monthInput.value = formatMonthValue(payload.year, payload.month);
  soupSpacingInput.value = String(normalizeSoupSpacing(payload.soupSpacing));
  renderCalendar(currentPlan);
  updateSummary({
    year: payload.year,
    month: payload.month,
    plan: currentPlan,
  });
}

function buildMealEditorOptions(selectElement, selectedDinner) {
  const mealOptions = new Set([...dinners, selectedDinner]);

  [...mealOptions]
    .sort((left, right) => left.localeCompare(right))
    .forEach((dinner) => {
      const option = document.createElement("option");
      option.value = dinner;
      option.textContent = dinner;
      option.selected = dinner === selectedDinner;
      selectElement.appendChild(option);
    });
}

function buildSlotMeals(totalBlocks, mealOptions, soupSpacing) {
  const normalizedSpacing = normalizeSoupSpacing(soupSpacing);
  const soups = shuffle(mealOptions.filter((meal) => isZupaMeal(meal)));
  const nonSoups = shuffle(mealOptions.filter((meal) => !isZupaMeal(meal)));

  if (!soups.length || !nonSoups.length) {
    const shuffledMeals = shuffle(mealOptions);
    return Array.from({ length: totalBlocks }, (_, index) => shuffledMeals[index % shuffledMeals.length]);
  }

  const slotMeals = [];
  const pattern = ["soup", ...Array.from({ length: normalizedSpacing }, () => "nonSoup")];
  let soupIndex = 0;
  let nonSoupIndex = 0;

  for (let index = 0; index < totalBlocks; index += 1) {
    const category = pattern[index % pattern.length];

    if (category === "soup") {
      slotMeals.push(soups[soupIndex % soups.length]);
      soupIndex += 1;
      continue;
    }

    slotMeals.push(nonSoups[nonSoupIndex % nonSoups.length]);
    nonSoupIndex += 1;
  }

  return slotMeals;
}

function isZupaMeal(mealName) {
  return mealName.trim().toLocaleLowerCase().startsWith("zupa");
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

function getSoupSpacing() {
  return normalizeSoupSpacing(Number(soupSpacingInput.value));
}

function normalizeSoupSpacing(value) {
  if (!Number.isInteger(value) || value < 1) {
    return 1;
  }

  return Math.min(value, 6);
}

function getCurrentPlanYear() {
  const [yearValue] = monthInput.value.split("-");
  return Number(yearValue);
}

function getCurrentPlanMonth() {
  const [, monthValue] = monthInput.value.split("-");
  return Number(monthValue) - 1;
}

function createStorageError(status) {
  if (status === 404 || status === 501) {
    return new Error(
      `Shared saving is unavailable. Stop the static server and start the app with ${SERVER_START_COMMAND}.`
    );
  }

  return new Error("Could not reach the shared dinner storage right now.");
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Could not reach the shared dinner storage right now.";
}

function setDefaultMonth() {
  const now = new Date();
  monthInput.value = formatMonthValue(now.getFullYear(), now.getMonth());
}

function formatMonthValue(year, zeroBasedMonth) {
  const month = String(zeroBasedMonth + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}