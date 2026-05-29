"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.contracts = exports.AgriContract = void 0;
require("reflect-metadata");
const fabric_contract_api_1 = require("fabric-contract-api");
let AgriContract = class AgriContract extends fabric_contract_api_1.Contract {
    async CreateRecord(ctx, id, do_am, tinh_trang, timestamp) {
        const record = {
            id: id,
            do_am: do_am,
            tinh_trang: tinh_trang,
            timestamp: timestamp,
            docType: 'agri_record'
        };
        await ctx.stub.putState(id, Buffer.from(JSON.stringify(record)));
        console.log(`Đã lưu thành công dữ liệu cho cây: ${id}`);
    }
    async GetHistory(ctx, id) {
        const promiseOfIterator = ctx.stub.getHistoryForKey(id);
        const results = [];
        for await (const keyMod of promiseOfIterator) {
            const resp = {
                timestamp: keyMod.timestamp,
                txid: keyMod.txId,
                data: Buffer.from(keyMod.value).toString('utf8')
            };
            results.push(resp);
        }
        return JSON.stringify(results);
    }
};
exports.AgriContract = AgriContract;
__decorate([
    (0, fabric_contract_api_1.Transaction)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [fabric_contract_api_1.Context, String, Number, String, String]),
    __metadata("design:returntype", Promise)
], AgriContract.prototype, "CreateRecord", null);
__decorate([
    (0, fabric_contract_api_1.Transaction)(false),
    (0, fabric_contract_api_1.Returns)('string'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [fabric_contract_api_1.Context, String]),
    __metadata("design:returntype", Promise)
], AgriContract.prototype, "GetHistory", null);
exports.AgriContract = AgriContract = __decorate([
    (0, fabric_contract_api_1.Info)({ title: 'AgriContract', description: 'Smart Contract cho Hệ thống Nông nghiệp' })
], AgriContract);
exports.contracts = [AgriContract];
