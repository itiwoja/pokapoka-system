"use strict";

// 予約の供給源。booking-resync.js が呼ぶ3つの関数を、モードごとに同じ契約で返す。
// TableCheck API 連携は 2026-10-11 に中止し、実APIの取得処理は archive/tablecheck/ へ退避した。
// 予約の手入力は未設計のため、MOCK 以外では予約を返さない (空のまま初回同期を完了させる)。
function createReservationSource(config) {
  if (config.isMock) {
    return {
      listReservations: async function () { return config.mock.listReservations(); },
      listSyncEvents: async function () { return config.mock.listSyncEvents(); },
      getReservation: async function (id) { return config.mock.getReservation(id); },
    };
  }
  return {
    listReservations: async function () { return []; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  };
}

module.exports = { createReservationSource: createReservationSource };
