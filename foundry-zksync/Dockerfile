FROM ubuntu

WORKDIR /foundry

RUN apt update && apt install -y wget
RUN wget https://github.com/matter-labs/foundry-zksync/releases/download/nightly/foundry_nightly_linux_amd64.tar.gz
RUN tar -xzvf ./foundry_nightly_linux_amd64.tar.gz

RUN mv ./forge /usr/local/bin/forge
RUN mv ./cast /usr/local/bin/cast

CMD ["forge"]
