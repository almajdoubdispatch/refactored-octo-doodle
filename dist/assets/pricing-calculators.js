(function (root) {
  "use strict";

  const RATES = {
    dry_van: { founder: 0.05, standard: 0.07 },
    reefer: { founder: 0.055, standard: 0.08 },
  };
  const FLAT_RATE = { founder: 245, standard: 299 };
  const MINIMUM_TRUCKS = { founder: 2, standard: 3 };

  function cents(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function estimateWeeklyPlanCosts({ equipment, weeklyLinehaulPerTruck, truckCount }) {
    if (!RATES[equipment]) throw new RangeError("Choose Dry Van or Reefer.");
    if (!Number.isFinite(weeklyLinehaulPerTruck) || weeklyLinehaulPerTruck < 0) {
      throw new RangeError("Enter a valid weekly linehaul amount per truck.");
    }
    if (!Number.isSafeInteger(truckCount) || truckCount < 1 || truckCount > 1000000) {
      throw new RangeError("Enter a valid accepted truck count.");
    }

    const totalLinehaul = cents(weeklyLinehaulPerTruck * truckCount);
    const rate = RATES[equipment];
    const percentage = (stage) => {
      const fee = cents(totalLinehaul * rate[stage]);
      return {
        rate: rate[stage],
        totalFee: fee,
        remainingLinehaul: cents(totalLinehaul - fee),
        breakEvenLinehaulPerTruck: cents(FLAT_RATE[stage] / rate[stage]),
      };
    };
    const flat = (stage) => ({
      perTruck: FLAT_RATE[stage],
      minimumTrucks: MINIMUM_TRUCKS[stage],
      eligibleAtEnteredCount: truckCount >= MINIMUM_TRUCKS[stage],
      totalFee: truckCount >= MINIMUM_TRUCKS[stage]
        ? cents(FLAT_RATE[stage] * truckCount)
        : null,
    });

    return {
      equipment,
      truckCount,
      weeklyLinehaulPerTruck: cents(weeklyLinehaulPerTruck),
      totalLinehaul,
      founderPercentage: percentage("founder"),
      standardPercentage: percentage("standard"),
      founderFlat: flat("founder"),
      standardFlat: flat("standard"),
    };
  }

  function calculateLoadEconomics({ linehaul, loadedMiles, deadheadMiles }) {
    if (!Number.isFinite(linehaul) || linehaul < 0) {
      throw new RangeError("Enter a valid linehaul amount.");
    }
    if (!Number.isFinite(loadedMiles) || loadedMiles <= 0) {
      throw new RangeError("Loaded miles must be greater than zero.");
    }
    if (!Number.isFinite(deadheadMiles) || deadheadMiles < 0) {
      throw new RangeError("Deadhead miles cannot be negative.");
    }

    const totalMiles = loadedMiles + deadheadMiles;
    const loadedRate = linehaul / loadedMiles;
    const allMilesRate = linehaul / totalMiles;
    return {
      linehaul: cents(linehaul),
      loadedMiles,
      deadheadMiles,
      totalMiles,
      loadedRate,
      allMilesRate,
      deadheadSharePercent: (deadheadMiles / totalMiles) * 100,
      rateDifference: loadedRate - allMilesRate,
    };
  }

  const api = { estimateWeeklyPlanCosts, calculateLoadEconomics };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) attachInterface(root.document, api);

  function attachInterface(document, calculator) {
    const currency = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
    const dollars = (value) => currency.format(value);
    const text = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };
    const status = (id, value, state = "info") => {
      const element = document.getElementById(id);
      if (!element) return;
      element.textContent = value;
      element.dataset.state = state;
    };

    const equipmentInput = document.getElementById("estimate-equipment");
    const linehaulInput = document.getElementById("estimate-linehaul-per-truck");
    const trucksInput = document.getElementById("estimate-truck-count");
    const pricingStatus = document.getElementById("pricing-estimate-status");

    function updatePricingEstimate() {
      if (!equipmentInput || !linehaulInput || !trucksInput) return;
      if (linehaulInput.value === "" || trucksInput.value === "") {
        status("pricing-estimate-status", "Enter weekly linehaul per truck and the total accepted truck count.");
        ["founder-percent-fee", "standard-percent-fee", "founder-flat-fee", "standard-flat-fee"]
          .forEach((id) => text(id, "—"));
        return;
      }

      try {
        const estimate = calculator.estimateWeeklyPlanCosts({
          equipment: equipmentInput.value,
          weeklyLinehaulPerTruck: linehaulInput.valueAsNumber,
          truckCount: trucksInput.valueAsNumber,
        });
        text("estimate-total-linehaul", dollars(estimate.totalLinehaul));
        text("founder-percent-rate", `${(estimate.founderPercentage.rate * 100).toFixed(1)}%`);
        text("founder-percent-fee", dollars(estimate.founderPercentage.totalFee));
        text("founder-percent-remaining", `${dollars(estimate.founderPercentage.remainingLinehaul)} remains before other operating costs.`);
        text("founder-percent-breakeven", `${dollars(estimate.founderPercentage.breakEvenLinehaulPerTruck)} linehaul per truck/week is the flat-rate comparison point.`);
        text("standard-percent-rate", `${(estimate.standardPercentage.rate * 100).toFixed(1)}%`);
        text("standard-percent-fee", dollars(estimate.standardPercentage.totalFee));
        text("standard-percent-remaining", `${dollars(estimate.standardPercentage.remainingLinehaul)} remains before other operating costs.`);
        text("standard-percent-breakeven", `${dollars(estimate.standardPercentage.breakEvenLinehaulPerTruck)} linehaul per truck/week is the flat-rate comparison point.`);

        text("founder-flat-fee", estimate.founderFlat.eligibleAtEnteredCount
          ? dollars(estimate.founderFlat.totalFee)
          : `Requires ${estimate.founderFlat.minimumTrucks}+ accepted trucks`);
        text("founder-flat-rule", estimate.founderFlat.eligibleAtEnteredCount
          ? `${dollars(estimate.founderFlat.perTruck)} per truck/week; eligible Founder seat required.`
          : "Founder Flat Rate minimum is two accepted trucks.");
        text("standard-flat-fee", estimate.standardFlat.eligibleAtEnteredCount
          ? dollars(estimate.standardFlat.totalFee)
          : `Requires ${estimate.standardFlat.minimumTrucks}+ accepted trucks`);
        text("standard-flat-rule", estimate.standardFlat.eligibleAtEnteredCount
          ? `${dollars(estimate.standardFlat.perTruck)} per truck/week for eligible new post-closure enrollments.`
          : "Standard Flat Rate minimum is three accepted trucks.");
        status("pricing-estimate-status", "Estimate calculated in this browser. No values were sent or saved.");
      } catch (error) {
        status("pricing-estimate-status", error.message, "error");
      }
    }

    [equipmentInput, linehaulInput, trucksInput].forEach((input) => {
      if (input) input.addEventListener("input", updatePricingEstimate);
      if (input) input.addEventListener("change", updatePricingEstimate);
    });
    if (pricingStatus) updatePricingEstimate();

    const loadInputs = [
      document.getElementById("load-linehaul"),
      document.getElementById("load-loaded-miles"),
      document.getElementById("load-deadhead-miles"),
    ];
    function updateLoadEconomics() {
      if (loadInputs.some((input) => !input || input.value === "")) {
        status("load-estimate-status", "Enter the linehaul amount, loaded miles, and deadhead miles.");
        ["loaded-linehaul-rpm", "all-miles-linehaul-rpm", "total-trip-miles", "deadhead-share", "rpm-difference"]
          .forEach((id) => text(id, "—"));
        return;
      }

      try {
        const result = calculator.calculateLoadEconomics({
          linehaul: loadInputs[0].valueAsNumber,
          loadedMiles: loadInputs[1].valueAsNumber,
          deadheadMiles: loadInputs[2].valueAsNumber,
        });
        text("loaded-linehaul-rpm", `${dollars(result.loadedRate)} / loaded mile`);
        text("all-miles-linehaul-rpm", `${dollars(result.allMilesRate)} / total mile`);
        text("total-trip-miles", `${number.format(result.totalMiles)} miles`);
        text("deadhead-share", `${result.deadheadSharePercent.toFixed(1)}% of total miles`);
        text("rpm-difference", `${dollars(result.rateDifference)} per mile`);
        status("load-estimate-status", "Load arithmetic calculated in this browser. No values were sent or saved.");
      } catch (error) {
        status("load-estimate-status", error.message, "error");
      }
    }

    loadInputs.forEach((input) => {
      if (input) input.addEventListener("input", updateLoadEconomics);
      if (input) input.addEventListener("change", updateLoadEconomics);
    });
    if (loadInputs.some(Boolean)) updateLoadEconomics();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
