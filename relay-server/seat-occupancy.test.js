"use strict";
var seats = require("./seat-occupancy");
var pass = 0, fail = 0;
function eq(name, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok: " + name); }
  else { fail++; console.error("  NG: " + name + "\n    got:  " + g + "\n    want: " + w); }
}

var walkins = new Map();
eq("empty", seats.toOccupiedSeats(new Map(), walkins, 0, 30, 120), []);
eq("register trimmed", seats.registerWalkin(walkins, " 5 ", 1000), { table: "5", source: "walkin", since: 1000 });
eq("reject blank", seats.registerWalkin(walkins, " ", 1000), null);
eq("reject non-string", seats.validateTable(5), null);
eq("reject too long", seats.validateTable("1234567"), null);
eq("release", seats.releaseWalkin(walkins, "5"), true);

var now = Date.parse("2026-07-16T18:00:00+09:00");
var reservations = new Map([
  ["near", { rid: "near", table: "2", name: "予約A", status: "booked", startAt: "2026-07-16T18:20:00+09:00", menu: [] }],
  ["future", { rid: "future", table: "4", name: "予約C", status: "booked", startAt: "2026-07-16T19:00:01+09:00", menu: [] }],
  ["cancel", { rid: "cancel", table: "6", name: "予約D", status: "canceled", startAt: "2026-07-16T18:10:00+09:00", menu: [] }],
  ["nearer", { rid: "nearer", table: "2", name: "予約直近", status: "booked", startAt: "2026-07-16T18:05:00+09:00", menu: [] }],
]);
walkins.set("2", { table: "2", source: "walkin", since: 500 });
walkins.set("9", { table: "9", source: "walkin", since: 600 });
eq("merge reservations and prefer reservation", seats.toOccupiedSeats(reservations, walkins, now, 30, 120), [
  { table: "2", source: "reservation", rid: "nearer", name: "予約直近", since: Date.parse("2026-07-16T18:05:00+09:00") },
  { table: "9", source: "walkin", since: 600 },
]);
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
