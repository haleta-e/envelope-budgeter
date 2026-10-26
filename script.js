"use strict";

/* =====================================================================
   Envelope Budgeter
   Sections:
   1. Settings and DOM references
   2. State (the single source of truth)
   3. Storage (localStorage)
   4. Validation
   5. Calculations (pure functions, no DOM)
   6. Rendering (DOM updates)
   7. Event handlers
   8. Start-up
   ===================================================================== */

/* ---------- 1. Settings and DOM references ---------- */

// Change these two values to use another currency or number format.
const SETTINGS = { locale: "en-US", currency: "USD" };

const STORAGE_KEY = "envelopeBudgeter.v1";
const MAX_AMOUNT = 1000000000; // largest amount accepted in one field
const MAX_NAME_LENGTH = 60;

const budgetForm = document.getElementById("budget-form");
const incomeInput = document.getElementById("income");
const rentInput = document.getElementById("rent-amount");
const entryDropdown = document.getElementById("entry-dropdown");
const addEntryButton = document.getElementById("add-entry");
const clearButton = document.getElementById("clear");
const output = document.getElementById("output");
const errorSummary = document.getElementById("error-summary");

// The category list comes from the dropdown in index.html, so the HTML stays
// the one place where categories are defined (for now).
const CATEGORY_IDS = Array.from(entryDropdown.options).map(
  (option) => option.value
);

const moneyFormatter = new Intl.NumberFormat(SETTINGS.locale, {
  style: "currency",
  currency: SETTINGS.currency,
});

/* ---------- 2. State ---------- */

// Amounts are kept as the text the user typed. Totals are never stored;
// they are calculated from this object every time they are needed.
let state = createEmptyState();

function createEmptyState() {
  return { income: "", rent: "", expenses: [] };
}

function createId() {
  return `exp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function findExpense(id) {
  return state.expenses.find((expense) => expense.id === id);
}

function isStateEmpty() {
  return (
    state.income.trim() === "" &&
    state.rent.trim() === "" &&
    state.expenses.length === 0
  );
}

function getCategoryLabel(categoryId) {
  const option = Array.from(entryDropdown.options).find(
    (item) => item.value === categoryId
  );
  return option ? option.textContent : categoryId;
}

/* ---------- 3. Storage ---------- */
// localStorage lives only in this browser on this device. It is not secure
// and not synced, so only budget numbers and expense names are saved.

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Could not save budget data:", error);
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) {
      return createEmptyState();
    }
    return sanitizeState(JSON.parse(saved));
  } catch (error) {
    // Malformed JSON or storage blocked: start fresh instead of crashing.
    console.warn("Could not read saved budget data:", error);
    return createEmptyState();
  }
}

function clearSavedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Could not remove saved budget data:", error);
  }
}

// Never trust saved data: keep only the pieces that have the right shape.
function sanitizeState(data) {
  const clean = createEmptyState();

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return clean;
  }
  if (typeof data.income === "string") {
    clean.income = data.income;
  }
  if (typeof data.rent === "string") {
    clean.rent = data.rent;
  }
  if (Array.isArray(data.expenses)) {
    const seenIds = new Set();
    for (const item of data.expenses) {
      if (isSavedExpenseValid(item) && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        clean.expenses.push({
          id: item.id,
          category: item.category,
          name: item.name,
          amount: item.amount,
        });
      }
    }
  }
  return clean;
}

function isSavedExpenseValid(item) {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.id === "string" &&
    item.id !== "" &&
    typeof item.name === "string" &&
    typeof item.amount === "string" &&
    CATEGORY_IDS.includes(item.category)
  );
}

/* ---------- 4. Validation ---------- */

// Replaces cleanInputString() and isInvalidInput().
// The old cleanInputString() stripped "+", "-" and spaces, so "-50" silently
// became 50. The old isInvalidInput() only caught patterns like "1e5".
// parseAmount() instead accepts only digits with an optional 1-2 decimals and
// returns the amount in whole cents (integers avoid 0.1 + 0.2 rounding bugs).
function parseAmount(rawValue, label, { required = false } = {}) {
  const text = rawValue.trim();

  if (text === "") {
    return required ? { error: `${label} is required.` } : { cents: 0 };
  }
  if (text.startsWith("-")) {
    return { error: `${label} cannot be negative.` };
  }
  if (/e/i.test(text)) {
    return {
      error: `${label} must be a plain number (scientific notation is not supported).`,
    };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { error: `${label} must be a number like 25 or 25.50.` };
  }

  const cents = Math.round(Number(text) * 100);
  if (cents > MAX_AMOUNT * 100) {
    return {
      error: `${label} is too large (maximum ${MAX_AMOUNT.toLocaleString(
        SETTINGS.locale
      )}).`,
    };
  }
  return { cents };
}

/* ---------- 5. Calculations ---------- */

// Reads the budget data and returns either errors or trustworthy totals.
// It touches no DOM, so it is easy to test on its own.
function calculateBudgetTotals(budget) {
  const errors = [];

  function readAmount(rawValue, label, fieldId, options) {
    const result = parseAmount(rawValue, label, options);
    if (result.error) {
      errors.push({ fieldId, message: result.error });
      return 0;
    }
    return result.cents;
  }

  const income = readAmount(budget.income, "Income", "income", {
    required: true,
  });
  const rent = readAmount(budget.rent, "Rent", "rent-amount");

  const categoryTotals = {};
  const positionInCategory = {};
  for (const categoryId of CATEGORY_IDS) {
    categoryTotals[categoryId] = 0;
    positionInCategory[categoryId] = 0;
  }

  for (const expense of budget.expenses) {
    positionInCategory[expense.category] += 1;
    const label = `${getCategoryLabel(expense.category)} expense ${
      positionInCategory[expense.category]
    }`;

    if (expense.name.trim() === "") {
      errors.push({
        fieldId: `expense-${expense.id}-name`,
        message: `${label} needs a name.`,
      });
    } else if (expense.name.trim().length > MAX_NAME_LENGTH) {
      errors.push({
        fieldId: `expense-${expense.id}-name`,
        message: `${label} name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      });
    }

    categoryTotals[expense.category] += readAmount(
      expense.amount,
      `${label} amount`,
      `expense-${expense.id}-amount`,
      { required: true }
    );
  }

  const expenses =
    rent +
    CATEGORY_IDS.reduce((sum, categoryId) => sum + categoryTotals[categoryId], 0);

  return {
    errors,
    income,
    rent,
    categoryTotals,
    expenses,
    remaining: income - expenses,
  };
}

/* ---------- 6. Rendering ---------- */

function formatMoney(cents) {
  return moneyFormatter.format(cents / 100);
}

function createField(id, labelText, value, fieldName, attributes) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;

  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.value = value; // .value is safe: it is never parsed as HTML
  input.dataset.field = fieldName;
  input.autocomplete = "off";
  for (const [key, attributeValue] of Object.entries(attributes)) {
    input.setAttribute(key, attributeValue);
  }

  wrapper.append(label, input);
  return wrapper;
}

function createExpenseRow(expense, number) {
  const row = document.createElement("div");
  row.className = "expense-row";
  row.dataset.id = expense.id;

  const nameField = createField(
    `expense-${expense.id}-name`,
    `Expense ${number} Name`,
    expense.name,
    "name",
    { placeholder: "Name", maxlength: String(MAX_NAME_LENGTH) }
  );
  const amountField = createField(
    `expense-${expense.id}-amount`,
    `Expense ${number} Amount`,
    expense.amount,
    "amount",
    { placeholder: "Amount", inputmode: "decimal" }
  );

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.dataset.action = "delete";
  deleteButton.textContent = "Delete";
  const nameForLabel = expense.name.trim();
  deleteButton.setAttribute(
    "aria-label",
    nameForLabel
      ? `Delete expense ${number}: ${nameForLabel}`
      : `Delete expense ${number}`
  );

  row.append(nameField, amountField, deleteButton);
  return row;
}

function renderExpenses() {
  for (const categoryId of CATEGORY_IDS) {
    const container = document
      .getElementById(categoryId)
      .querySelector(".input-container");
    const rows = state.expenses
      .filter((expense) => expense.category === categoryId)
      .map((expense, index) => createExpenseRow(expense, index + 1));
    container.replaceChildren(...rows);
  }
}

function renderForm() {
  incomeInput.value = state.income;
  rentInput.value = state.rent;
  renderExpenses();
}

function clearInvalidMarks() {
  for (const element of budgetForm.querySelectorAll("[aria-invalid]")) {
    element.removeAttribute("aria-invalid");
  }
}

function hideErrors() {
  clearInvalidMarks();
  errorSummary.replaceChildren();
  errorSummary.classList.add("hide");
}

function hideResults() {
  output.replaceChildren();
  output.classList.add("hide");
}

function renderErrors(errors) {
  clearInvalidMarks();

  const heading = document.createElement("p");
  heading.textContent = "Error: please fix the following before calculating.";

  const list = document.createElement("ul");
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error.message;
    list.append(item);

    const field = document.getElementById(error.fieldId);
    if (field) {
      field.setAttribute("aria-invalid", "true");
    }
  }

  errorSummary.replaceChildren(heading, list);
  errorSummary.classList.remove("hide");
}

function renderResults(totals) {
  const isOver = totals.remaining < 0;

  const status = document.createElement("span");
  status.className = isOver ? "deficit" : "surplus";
  status.textContent = isOver
    ? `Over Budget by ${formatMoney(Math.abs(totals.remaining))}`
    : `${formatMoney(totals.remaining)} Remaining`;

  const divider = document.createElement("hr");

  const incomeLine = document.createElement("p");
  incomeLine.textContent = `${formatMoney(totals.income)} Total Income`;

  const expensesLine = document.createElement("p");
  expensesLine.textContent = `${formatMoney(totals.expenses)} Total Expenses`;

  output.replaceChildren(status, divider, incomeLine, expensesLine);
  output.classList.remove("hide");
}

// Validates, then shows either the errors or the results, never both.
// Returns true when the results were shown.
function showBudgetResults() {
  const totals = calculateBudgetTotals(state);

  if (totals.errors.length > 0) {
    hideResults();
    renderErrors(totals.errors);
    return false;
  }

  hideErrors();
  renderResults(totals);
  return true;
}

// After an edit or delete, keep whatever is on screen up to date.
function refreshIfShown() {
  const isShowing =
    !output.classList.contains("hide") ||
    !errorSummary.classList.contains("hide");
  if (isShowing) {
    showBudgetResults();
  }
}

/* ---------- 7. Event handlers ---------- */

function handleSubmit(event) {
  event.preventDefault();
  const succeeded = showBudgetResults();
  if (!succeeded) {
    errorSummary.focus();
  }
}

function handleAddEntry() {
  const expense = {
    id: createId(),
    category: entryDropdown.value,
    name: "",
    amount: "",
  };
  state.expenses.push(expense);
  saveState();
  renderExpenses();
  document.getElementById(`expense-${expense.id}-name`).focus();
}

// One "input" listener on the whole form handles income, rent and every
// expense row (event delegation), including rows created later.
function handleInput(event) {
  const target = event.target;

  if (target === incomeInput) {
    state.income = target.value;
  } else if (target === rentInput) {
    state.rent = target.value;
  } else {
    const row = target.closest(".expense-row");
    const expense = row ? findExpense(row.dataset.id) : undefined;
    if (!expense) {
      return;
    }
    if (target.dataset.field === "name") {
      expense.name = target.value;
    } else if (target.dataset.field === "amount") {
      expense.amount = target.value;
    } else {
      return;
    }
  }

  saveState();
  refreshIfShown();
}

function handleFormClick(event) {
  const deleteButton = event.target.closest("[data-action='delete']");
  if (!deleteButton) {
    return;
  }

  const row = deleteButton.closest(".expense-row");
  const expense = findExpense(row.dataset.id);
  if (!expense) {
    return;
  }

  // Only ask for confirmation when there is something to lose.
  const hasContent =
    expense.name.trim() !== "" || expense.amount.trim() !== "";
  if (hasContent) {
    const description = expense.name.trim() || "this expense";
    if (!window.confirm(`Delete "${description}"?`)) {
      return;
    }
  }

  state.expenses = state.expenses.filter((item) => item.id !== expense.id);
  saveState();
  renderExpenses();
  refreshIfShown();
  entryDropdown.focus();
}

function handleClear() {
  if (
    !isStateEmpty() &&
    !window.confirm(
      "Clear the whole budget? This also deletes the data saved in this browser."
    )
  ) {
    return;
  }

  state = createEmptyState();
  clearSavedState();
  renderForm();
  hideErrors();
  hideResults();
}

/* ---------- 8. Start-up ---------- */

function init() {
  state = loadState();
  renderForm();

  budgetForm.addEventListener("submit", handleSubmit);
  budgetForm.addEventListener("input", handleInput);
  budgetForm.addEventListener("click", handleFormClick);
  addEntryButton.addEventListener("click", handleAddEntry);
  clearButton.addEventListener("click", handleClear);
}

init();