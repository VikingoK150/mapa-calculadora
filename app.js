(() => {
  const countries = window.COUNTRY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const countrySelect = $("country");
  const output = $("results");
  const vehicleSelect = $("vehicle");
  const valueInput = $("value");
  const freightInput = $("freight");
  const insuranceInput = $("insurance");
  const zero = { low: 0, high: 0 };
  const technologies = { GASOLINA: "Gasolina", DIESEL: "Diésel", HIBRIDO: "Híbrido", ELECTRICO: "Eléctrico" };
  const vehicleLabels = { SEDAN: "Sedán", SUV: "SUV", PICKUP: "Pickup", MOTO: "Motocicleta", CAMION: "Camión" };

  const add = (a, b) => ({ low: a.low + b.low, high: a.high + b.high });
  const chooseAmount = (rules, input) => rules.find((rule) => !rule.vehicleType || rule.vehicleType.includes(input.vehicleType))?.amount ?? zero;
  const bracketRate = (brackets, amount) => brackets.find((bracket) => bracket.max === null || amount <= bracket.max)?.rate ?? brackets.at(-1).rate;

  function ruleRate(definition, input, cif) {
    switch (definition.kind) {
      case "FLAT": return { low: definition.rate, high: definition.rate };
      case "RANGE": return { low: definition.low, high: definition.high };
      case "RULES": {
        const match = definition.rules.find((rule) =>
          (!rule.technology || rule.technology.includes(input.technology)) &&
          (!rule.vehicleType || rule.vehicleType.includes(input.vehicleType)) &&
          (rule.engineOver2000 === undefined || rule.engineOver2000 === input.engineOver2000));
        const rate = match?.rate ?? 0;
        return { low: rate, high: rate };
      }
      case "BY_CIF_BRACKET": return { low: bracketRate(definition.brackets, cif.low), high: bracketRate(definition.brackets, cif.high) };
      case "BY_VALUE_BRACKET": {
        const rate = bracketRate(definition.brackets, input.vehicleValue);
        return { low: rate, high: rate };
      }
      case "BY_CO2": {
        if (definition.zeroForElectric && input.technology === "ELECTRICO") return zero;
        const rate = definition.rates[input.co2Band] ?? 0;
        return { low: rate, high: rate };
      }
      default: return zero;
    }
  }

  function stepAmount(step, input, cif, bases) {
    if (step.type === "FIXED") return chooseAmount(step.rules, input);
    if (step.onlyIfCifOver !== undefined && cif.high <= step.onlyIfCifOver) return null;
    const base = step.base.reduce((sum, key) => add(sum, bases.get(key) ?? zero), zero);
    const rate = ruleRate(step.rate, input, cif);
    return {
      low: step.onlyIfCifOver === undefined || cif.low > step.onlyIfCifOver ? base.low * rate.low : 0,
      high: base.high * rate.high,
    };
  }

  function vehicleTypeVaries(config) {
    return config.status !== "INFO_ONLY" && (
      Object.keys(config.freight).some((key) => key !== "DEFAULT") ||
      config.steps.some((step) => step.type === "FIXED"
        ? step.rules.some((rule) => rule.vehicleType)
        : step.rate.kind === "RULES" && step.rate.rules.some((rule) => rule.vehicleType)) ||
      config.extraCosts.some((cost) => cost.vehicleType));
  }

  function pickupIsDistinct(config) {
    if (!vehicleTypeVaries(config)) return false;
    const suv = config.freight.SUV ?? config.freight.DEFAULT;
    const pickup = config.freight.PICKUP ?? config.freight.DEFAULT;
    const specificRule = (rule) => rule.vehicleType && rule.vehicleType.includes("SUV") !== rule.vehicleType.includes("PICKUP");
    return suv.low !== pickup.low || suv.high !== pickup.high || config.steps.some((step) =>
      step.type === "FIXED" ? step.rules.some(specificRule) : step.rate.kind === "RULES" && step.rate.rules.some(specificRule)) ||
      config.extraCosts.some(specificRule);
  }

  function calculate(config, input) {
    if (input.vehicleValue <= 0 || config.status === "INFO_ONLY") return null;
    const freight = input.freightMode === "EXACTO" && input.freightExact > 0
      ? { low: input.freightExact, high: input.freightExact }
      : (config.freight[input.vehicleType] ?? config.freight.DEFAULT ?? zero);
    const insurance = input.insuranceOverride === null
      ? (config.insuranceRate !== undefined ? Math.round(input.vehicleValue * config.insuranceRate) : config.insuranceDefault)
      : input.insuranceOverride;
    const cif = { low: input.vehicleValue + freight.low + insurance, high: input.vehicleValue + freight.high + insurance };
    const bases = new Map([["VALUE", { low: input.vehicleValue, high: input.vehicleValue }], ["CIF", cif]]);
    const lines = [];
    const warnings = config.restriction ? [config.restriction] : [];

    for (const step of config.steps) {
      const amount = stepAmount(step, input, cif, bases);
      if (amount === null) continue;
      bases.set(step.key, amount);
      lines.push({ key: step.key, label: step.label, amount });
      if (step.type === "TAX" && step.warning) warnings.push(step.warning);
    }

    const extraCosts = config.extraCosts.reduce((sum, cost) => add(sum, chooseAmount([cost], input)), zero);
    const operating = { low: freight.low + insurance, high: freight.high + insurance };
    const total = lines.reduce((sum, line) => add(sum, line.amount), add(operating, extraCosts));
    return { freight, insurance, cif, lines, extraCosts, total, warnings, unquantified: config.unquantified };
  }

  function formatMoney(amount, currency) {
    return new Intl.NumberFormat("es", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  }

  function formatRange(range, currency) {
    const low = formatMoney(Math.round(range.low), currency);
    const high = formatMoney(Math.round(range.high), currency);
    return range.low === range.high ? low : `${low} – ${high}`;
  }

  function row(label, value) {
    return `<div class="row"><span>${label}</span><span>${value}</span></div>`;
  }

  const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const selectedCountry = () => countries[countrySelect.value];
  const num = (field) => Math.max(0, Number(field.value) || 0);

  function updateControls() {
    const config = selectedCountry();
    const asks = config.asks ?? [];
    const varies = vehicleTypeVaries(config);
    const pickupDistinct = pickupIsDistinct(config);
    $("vehicle-wrap").classList.toggle("hidden", !varies);
    $("technology-wrap").classList.toggle("hidden", !asks.includes("TECHNOLOGY"));
    $("engine-wrap").classList.toggle("hidden", !asks.includes("ENGINE_OVER_2000"));
    $("co2-wrap").classList.toggle("hidden", !asks.includes("CO2_BAND"));
    $("freight-wrap").classList.toggle("hidden", document.querySelector('input[name="freight-mode"]:checked').value !== "EXACTO");

    const allowedVehicles = pickupDistinct ? ["SEDAN", "SUV", "PICKUP", "MOTO", "CAMION"] : ["SEDAN", "SUV", "MOTO", "CAMION"];
    const previous = vehicleSelect.value;
    vehicleSelect.replaceChildren(...allowedVehicles.map((type) => new Option(vehicleLabels[type], type)));
    vehicleSelect.value = allowedVehicles.includes(previous) ? previous : "SEDAN";

    const currency = config.currency;
    $("value-label").textContent = `Valor del vehículo (${currency})`;
    $("freight-label").textContent = `Flete exacto (${currency})`;
    $("insurance-label").textContent = `Seguro (${currency}, opcional)`;
    const value = num(valueInput);
    const automaticInsurance = config.insuranceRate !== undefined ? Math.round(value * config.insuranceRate) : config.insuranceDefault;
    insuranceInput.placeholder = formatMoney(automaticInsurance, currency);
    render();
  }

  function render() {
    const config = selectedCountry();
    const input = {
      vehicleValue: num(valueInput),
      vehicleType: vehicleSelect.value || "SEDAN",
      technology: $("technology").value,
      engineOver2000: $("engine").value === "true",
      co2Band: $("co2").value,
      freightMode: document.querySelector('input[name="freight-mode"]:checked').value,
      freightExact: num(freightInput),
      insuranceOverride: insuranceInput.value.trim() === "" ? null : num(insuranceInput),
    };

    if (config.status === "INFO_ONLY") {
      output.innerHTML = `<h2>${esc(config.label)}</h2><div class="notice">Este destino no tiene un cálculo estándar en esta herramienta.</div>${config.restriction ? `<p>${esc(config.restriction)}</p>` : ""}${renderNotes(config)}<p class="footnote">No se muestra un total para este destino.</p>`;
      return;
    }

    const result = calculate(config, input);
    if (!result) {
      output.innerHTML = `<h2>Estimación</h2><div class="empty">Ingresa el valor del vehículo para calcular los costos de exportación y nacionalización.</div>`;
      return;
    }

    const warnings = result.warnings.map((warning) => `<div class="notice">${esc(warning)}</div>`).join("");
    const lines = result.lines.map((line) => row(esc(line.label), formatRange(line.amount, config.currency))).join("");
    const partial = config.status === "PARTIAL" ? `<p class="partial">Estimación parcial</p>` : "";
    const unquantified = result.unquantified.length
      ? `<div class="section-label">No incluidos en el total</div><ul>${result.unquantified.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
    output.innerHTML = `<h2>Estimado para ${esc(config.label)}</h2>${partial}${warnings}<div class="total"><small>Costos de exportación + nacionalización (no incluye el vehículo)</small><strong>${formatRange(result.total, config.currency)}</strong></div>${row("Flete", formatRange(result.freight, config.currency))}${row("Seguro", formatMoney(result.insurance, config.currency))}${row("CIF estimado", formatRange(result.cif, config.currency))}${lines ? `<div class="section-label">Impuestos y cargos</div>${lines}` : ""}${result.extraCosts.high > 0 ? row("Gastos locales", formatRange(result.extraCosts, config.currency)) : ""}${renderNotes(config)}${unquantified}`;
  }

  function renderNotes(config) {
    const notes = config.notes ?? {};
    const age = notes.age?.label ?? (notes.age?.kind === "MAX_YEARS" ? `Máximo ${notes.age.years} años` : notes.age?.kind === "NO_LIMIT" ? "Sin límite indicado" : notes.age?.kind === "FROM_YEAR" ? `Desde ${notes.age.year}` : notes.age?.text ?? "");
    const items = [age && `Años permitidos: ${age}`, notes.titles && `Títulos: ${notes.titles}`, notes.note].filter(Boolean);
    return items.length ? `<div class="section-label">Notas del destino</div><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
  }

  for (const [key, config] of Object.entries(countries).sort((a, b) => a[1].label.localeCompare(b[1].label, "es"))) {
    countrySelect.add(new Option(`${config.label}${config.status === "PARTIAL" ? " · Parcial" : config.status === "INFO_ONLY" ? " · Informativo" : ""}`, key));
  }
  countrySelect.value = countries.ARGENTINA ? "ARGENTINA" : Object.keys(countries)[0];
  document.querySelectorAll("input, select").forEach((control) => control.addEventListener("input", updateControls));
  document.querySelectorAll('input[name="freight-mode"]').forEach((control) => control.addEventListener("change", updateControls));
  updateControls();
})();
