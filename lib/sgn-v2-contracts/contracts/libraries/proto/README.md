# about soltype

Due to pb gen sol only supports soltype field option defined in the same proto file. When we have multiple proto files that need soltype, it will break on go side. The short term solution is to manually sync proto files to go repo, and remove soltype related.

## proper solution

have a single file like soltype.proto define the field option, then other proto files just import it. pb gen sol need to parse imported proto and ExtName will have soltype.proto package prefix eg. opt.soltype instead of just soltype. unless all protos have same package which will cause issue for pb gen sol as it outputs .sol files based on proto package name.

or maybe we just register the fieldoption w/ proto team officially? still need to import another proto but package will be celer.opt
https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/descriptor.proto#L325

# Generating Solidity bindings

From the project repo root, run:

```sh
protoc --sol_out=importpb=true:contracts/libraries contracts/libraries/proto/{filename}.proto
```
