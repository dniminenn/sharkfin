// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// WebHID surface the web build uses; TypeScript's DOM lib does not ship it.

interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
  children: HIDCollectionInfo[];
  featureReports: {
    reportId: number;
    items: { reportSize: number; reportCount: number }[];
  }[];
  inputReports: { reportId: number }[];
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDevice {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HIDCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: "inputreport", listener: (e: HIDInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (e: HIDInputReportEvent) => void): void;
}

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
}

interface Navigator {
  readonly hid: HID;
}
