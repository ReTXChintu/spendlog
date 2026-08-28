export interface DefaultCategorySeed {
  name: string;
  icon: string;
  color: string;
  keywords: string[];
}

// Seeded once into the Category table as system defaults (userId = null),
// each with a matching CategoryRule so new transactions auto-categorize
// out of the box. Users can add their own rules/categories on top of these.
export const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  {
    name: "Food & Dining",
    icon: "utensils",
    color: "#f97316",
    keywords: ["swiggy", "zomato", "restaurant", "cafe", "eatery", "dominos", "pizza", "starbucks"],
  },
  {
    name: "Groceries",
    icon: "shopping-basket",
    color: "#22c55e",
    keywords: ["bigbasket", "blinkit", "zepto", "grofers", "dmart", "grocery", "supermarket"],
  },
  {
    name: "Transport",
    icon: "car",
    color: "#0ea5e9",
    keywords: ["uber", "ola", "rapido", "irctc", "fuel", "petrol", "diesel", "metro", "fastag"],
  },
  {
    name: "Shopping",
    icon: "shopping-bag",
    color: "#a855f7",
    keywords: ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa"],
  },
  {
    name: "Bills & Utilities",
    icon: "receipt",
    color: "#eab308",
    keywords: ["electricity", "airtel", "jio", "vodafone", "vi ", "recharge", "broadband", "water bill", "gas bill"],
  },
  {
    name: "Entertainment",
    icon: "film",
    color: "#ec4899",
    keywords: ["netflix", "spotify", "hotstar", "prime video", "bookmyshow", "pvr", "inox"],
  },
  {
    name: "Health",
    icon: "heart-pulse",
    color: "#ef4444",
    keywords: ["pharmacy", "apollo", "hospital", "clinic", "medplus", "1mg", "diagnostic"],
  },
  {
    name: "Housing",
    icon: "home",
    color: "#8b5cf6",
    keywords: ["rent", "landlord", "maintenance charge", "society"],
  },
  {
    name: "EMI & Loans",
    icon: "credit-card",
    color: "#f43f5e",
    keywords: ["emi", "loan", "installment"],
  },
  {
    name: "Investments",
    icon: "trending-up",
    color: "#14b8a6",
    keywords: ["mutual fund", "sip ", "zerodha", "groww", "upstox", "nps"],
  },
  {
    name: "Income",
    icon: "wallet",
    color: "#16a34a",
    keywords: ["salary", "payroll", "interest credited", "cashback", "refund"],
  },
  {
    name: "Others",
    icon: "more-horizontal",
    color: "#64748b",
    keywords: [],
  },
];
