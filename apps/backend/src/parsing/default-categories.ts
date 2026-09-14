// icon values are ids in the shared icon sprite from the approved design
// (apps/frontend/src/components/Icon.tsx). The Flutter app maps the same ids
// to Material icons, so category appearance is defined once, here.
export interface DefaultCategorySeed {
  name: string;
  icon: string;
  color: string;
  /// Which way money has to be moving. Everything here is spending
  /// unless it says otherwise - Income only ever comes in, and the two
  /// catch-alls go either way.
  direction: "IN" | "OUT" | "BOTH";
  keywords: string[];
}

// Seeded once into the Category table as system defaults (userId = null),
// each with a matching CategoryRule so new transactions auto-categorize
// out of the box. Users can add their own rules/categories on top of these.
export const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  {
    name: "Food & Dining",
    icon: "ic-food",
    color: "#F97316",
    direction: "OUT",
    keywords: ["swiggy", "zomato", "restaurant", "cafe", "eatery", "dominos", "pizza", "starbucks"],
  },
  {
    name: "Groceries",
    icon: "ic-basket",
    color: "#84CC16",
    direction: "OUT",
    keywords: ["bigbasket", "blinkit", "zepto", "grofers", "dmart", "grocery", "supermarket"],
  },
  {
    name: "Transport",
    icon: "ic-car",
    color: "#0EA5E9",
    direction: "OUT",
    keywords: ["uber", "ola", "rapido", "irctc", "fuel", "petrol", "diesel", "metro", "fastag"],
  },
  {
    name: "Shopping",
    icon: "ic-bag",
    color: "#EC4899",
    direction: "OUT",
    keywords: ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa"],
  },
  {
    name: "Bills & Utilities",
    icon: "ic-bolt",
    color: "#EAB308",
    direction: "OUT",
    keywords: ["electricity", "airtel", "jio", "vodafone", "vi ", "recharge", "broadband", "water bill", "gas bill"],
  },
  {
    name: "Entertainment",
    icon: "ic-play",
    color: "#A855F7",
    direction: "OUT",
    keywords: ["netflix", "spotify", "hotstar", "prime video", "bookmyshow", "pvr", "inox"],
  },
  {
    name: "Health",
    icon: "ic-health",
    color: "#F43F5E",
    direction: "OUT",
    keywords: ["pharmacy", "apollo", "hospital", "clinic", "medplus", "1mg", "diagnostic"],
  },
  {
    name: "Housing",
    icon: "ic-home",
    color: "#A8A29E",
    direction: "OUT",
    keywords: ["rent", "landlord", "maintenance charge", "society"],
  },
  {
    name: "EMI & Loans",
    icon: "ic-percent",
    color: "#64748B",
    direction: "OUT",
    keywords: ["emi", "loan", "installment"],
  },
  {
    name: "Investments",
    icon: "ic-trend",
    color: "#16A34A",
    direction: "BOTH",
    keywords: ["mutual fund", "sip ", "zerodha", "groww", "upstox", "nps"],
  },
  {
    name: "Income",
    icon: "ic-wallet",
    color: "#16A34A",
    direction: "IN",
    keywords: ["salary", "payroll", "interest credited", "cashback", "refund"],
  },
  {
    name: "Others",
    icon: "ic-dots",
    color: "#94A3B8",
    direction: "BOTH",
    keywords: [],
  },
];
