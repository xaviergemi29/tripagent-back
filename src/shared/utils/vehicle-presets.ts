export const VEHICLE_PRESETS = [
  {
    name: "Sprinter (20 Lugares)",
    layoutMap: [
      ["01", "02", "03", "AISLE"],
      ["04", "05", "AISLE", "06"],
      ["07", "08", "AISLE", "09"],
      ["10", "11", "AISLE", "12"],
      ["13", "14", "AISLE", "15"],
      ["16", "17", "18", "19"],
    ],
  },
  {
    name: "Autobús Gran Tour (50 Lugares - 2x2)",
    layoutMap: [
      ...Array.from({ length: 12 }, (_, i) => [
        String(i * 4 + 1).padStart(2, "0"),
        String(i * 4 + 2).padStart(2, "0"),
        "AISLE",
        String(i * 4 + 3).padStart(2, "0"),
        String(i * 4 + 4).padStart(2, "0"),
      ]),
      ["49", "50", "AISLE", null, null],
    ],
  },
];
