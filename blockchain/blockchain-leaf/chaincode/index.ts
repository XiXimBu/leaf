import 'reflect-metadata';
import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

@Info({title: 'AgriContract', description: 'Smart Contract cho Hệ thống Nông nghiệp'})
export class AgriContract extends Contract {

    @Transaction()
    public async CreateRecord(ctx: Context, id: string, recordJsonString: string): Promise<void> {
        let record;
        try {
            record = JSON.parse(recordJsonString);
        } catch (err) {
            throw new Error(`Dữ liệu không phải là JSON hợp lệ: ${err}`);
        }

        // Lưu nguyên payload — không thêm metadata. Schema khớp với MongoDB bên ngoài.
        // Key của state DB chính là `id` (= tree_id) do gateway truyền vào.
        await ctx.stub.putState(id, Buffer.from(JSON.stringify(record)));
        console.log(`Đã lưu thành công dữ liệu cho cây: ${id}`);
    }

    @Transaction(false)
    @Returns('string')
    public async GetHistory(ctx: Context, id: string): Promise<string> {
        // Dùng GetHistoryForKey lôi toàn bộ lịch sử từ Sổ cái (Ledger)
        const promiseOfIterator = ctx.stub.getHistoryForKey(id);
        const results = [];
        
        for await (const keyMod of promiseOfIterator) {
            let parsedData: any = {};
            try {
                parsedData = JSON.parse(Buffer.from(keyMod.value).toString('utf8'));
            } catch (err) {
                console.log(`Failed to parse data for tx ${keyMod.txId}`);
            }

            const resp = {
                block_timestamp: keyMod.timestamp,
                record_timestamp: parsedData.timestamp, // <--- lấy timestamp gốc đã lưu
                txid: keyMod.txId,
                data: parsedData
            };
            results.push(resp);
        }
        
        return JSON.stringify(results);
    }
}

export const contracts: Array<typeof Contract> = [AgriContract];