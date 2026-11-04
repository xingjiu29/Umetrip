const req = $request || {};
const res = $response || {};
const headers = req.headers || {};
const rpid = String(headers.rpid || headers.Rpid || "").trim();

const hideWholeResponse = new Set([
  "1000002",
  "1000019",
  "1430064",
  "1370286"
]);

if (hideWholeResponse.has(rpid)) {
  $done({
    status: "HTTP/1.1 404 Not Found",
    headers: res.headers || {},
    body: ""
  });
} else if (rpid !== "1100001") {
  $done({});
} else {
  const body = res.body;

  if (!(body instanceof Uint8Array)) {
    console.log("UMETRIP: 1100001 body is not Uint8Array; passthrough");
    $done({});
  } else {
    const decoder = new TextDecoder();

    function readVarint(bytes, pos) {
      let value = 0;
      let shift = 0;

      while (pos < bytes.length && shift < 53) {
        const byte = bytes[pos++];
        value += (byte & 0x7f) * Math.pow(2, shift);

        if ((byte & 0x80) === 0) {
          return [value, pos];
        }

        shift += 7;
      }

      throw new Error("Invalid Protobuf varint");
    }

    function writeVarint(value) {
      const out = [];

      while (value > 127) {
        out.push((value & 0x7f) | 0x80);
        value = Math.floor(value / 128);
      }

      out.push(value);
      return out;
    }

    function parseFields(bytes) {
      const fields = [];
      let pos = 0;

      while (pos < bytes.length) {
        const start = pos;
        let tag;
        [tag, pos] = readVarint(bytes, pos);

        const fieldNo = Math.floor(tag / 8);
        const wireType = tag & 7;
        let payloadStart;
        let payloadEnd;

        if (fieldNo <= 0) {
          throw new Error("Invalid Protobuf field number");
        }

        if (wireType === 0) {
          [, pos] = readVarint(bytes, pos);
        } else if (wireType === 1) {
          pos += 8;
        } else if (wireType === 2) {
          let length;
          [length, pos] = readVarint(bytes, pos);
          payloadStart = pos;
          pos += length;
          payloadEnd = pos;
        } else if (wireType === 5) {
          pos += 4;
        } else {
          throw new Error("Unsupported Protobuf wire type: " + wireType);
        }

        if (pos > bytes.length) {
          throw new Error("Truncated Protobuf field");
        }

        fields.push({
          fieldNo,
          wireType,
          start,
          end: pos,
          payloadStart,
          payloadEnd
        });
      }

      return fields;
    }

    function concat(parts) {
      let totalLength = 0;

      for (const part of parts) {
        totalLength += part.length;
      }

      const output = new Uint8Array(totalLength);
      let offset = 0;

      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }

      return output;
    }

    function wrapLengthField(fieldNo, payload) {
      return concat([
        new Uint8Array(writeVarint(fieldNo * 8 + 2)),
        new Uint8Array(writeVarint(payload.length)),
        payload
      ]);
    }

    function getPayload(bytes, field) {
      return bytes.subarray(field.payloadStart, field.payloadEnd);
    }

    function shouldRemoveModule(record) {
      const text = decoder.decode(record);

      if (
        /"groupId"\s*:\s*111402/.test(text) ||
        /"groupId"\s*:\s*111403/.test(text) ||
        /"groupId"\s*:\s*111404/.test(text)
      ) {
        return true;
      }

      return (
        text.includes("会员卡片") ||
        (text.includes("我的页") && text.includes("腰部"))
      );
    }

    function cleanModuleList(bytes) {
      const fields = parseFields(bytes);
      const kept = [];
      let removed = 0;

      for (const field of fields) {
        if (
          field.fieldNo === 5 &&
          field.wireType === 2 &&
          shouldRemoveModule(getPayload(bytes, field))
        ) {
          removed++;
        } else {
          kept.push(bytes.subarray(field.start, field.end));
        }
      }

      return [concat(kept), removed];
    }

    function cleanInner(bytes) {
      const fields = parseFields(bytes);
      const kept = [];
      let removed = 0;

      for (const field of fields) {
        if (field.fieldNo === 11 && field.wireType === 2) {
          const [newList, count] = cleanModuleList(getPayload(bytes, field));
          kept.push(wrapLengthField(11, newList));
          removed += count;
        } else {
          kept.push(bytes.subarray(field.start, field.end));
        }
      }

      return [concat(kept), removed];
    }

    function cleanOuter(bytes) {
      const fields = parseFields(bytes);
      const kept = [];
      let removed = 0;

      for (const field of fields) {
        if (field.fieldNo === 1 && field.wireType === 2) {
          const [newInner, count] = cleanInner(getPayload(bytes, field));
          kept.push(wrapLengthField(1, newInner));
          removed += count;
        } else {
          kept.push(bytes.subarray(field.start, field.end));
        }
      }

      return [concat(kept), removed];
    }

    try {
      const fields = parseFields(body);
      const kept = [];
      let removed = 0;

      for (const field of fields) {
        if (field.fieldNo === 7 && field.wireType === 2) {
          const [newPayload, count] = cleanOuter(getPayload(body, field));
          kept.push(wrapLengthField(7, newPayload));
          removed += count;
        } else {
          kept.push(body.subarray(field.start, field.end));
        }
      }

      if (removed > 0) {
        console.log("UMETRIP removed module records: " + removed);
        $done({ body: concat(kept) });
      } else {
        console.log("UMETRIP: no target modules found; passthrough");
        $done({});
      }
    } catch (error) {
      console.log("UMETRIP Protobuf parse failed; passthrough: " + error);
      $done({});
    }
  }
}
